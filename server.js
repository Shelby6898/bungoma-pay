require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// ─── Startup: Validate all required environment variables ────────────────────
const REQUIRED_ENV = ['CONSUMER_KEY', 'CONSUMER_SECRET', 'SHORTCODE', 'PASSKEY', 'CALLBACK_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`[FATAL] Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

const {
    CONSUMER_KEY,
    CONSUMER_SECRET,
    SHORTCODE,
    PASSKEY,
    CALLBACK_URL,
    PORT = 3000,
    NODE_ENV = 'development'
} = process.env;

const app = express();

// ─── Trust proxy fix for Termux / Cloudflare tunnel ──────────────────────────
// Fixes: ERR_ERL_UNEXPECTED_X_FORWARDED_FOR from express-rate-limit
app.set('trust proxy', 1);

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(cors({
    origin: NODE_ENV === 'production'
        ? process.env.ALLOWED_ORIGIN || false
        : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname, { index: false }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const stkLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many payment requests. Please wait a moment.' }
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Slow down.' }
});

app.use('/api/', generalLimiter);
app.use('/api/stkpush', stkLimiter);

// ─── In-memory transaction store ──────────────────────────────────────────────
let transactions = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPhone(phone) {
    const cleaned = String(phone).replace(/\s+/g, '').replace(/^\+/, '');
    if (/^254[17]\d{8}$/.test(cleaned)) return cleaned;
    if (/^0[17]\d{8}$/.test(cleaned)) return '254' + cleaned.slice(1);
    if (/^[17]\d{8}$/.test(cleaned)) return '254' + cleaned;
    return null;
}

async function getSafaricomToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    const res = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        {
            headers: { Authorization: `Basic ${auth}` },
            timeout: 10000
        }
    );
    if (!res.data?.access_token) throw new Error('No access_token in Safaricom response');
    return res.data.access_token;
}

function getStkCredentials() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
    return { timestamp, password };
}

function logTxn(type, data) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${type}]`, JSON.stringify(data));
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── STK Push ─────────────────────────────────────────────────────────────────
app.post('/api/stkpush', async (req, res) => {
    try {
        const { phone, amount, service, ward, clientId } = req.body;

        if (!phone || !amount) {
            return res.status(400).json({ success: false, error: 'phone and amount are required' });
        }

        const formattedPhone = formatPhone(phone);
        if (!formattedPhone) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number. Use 07XXXXXXXX or 2547XXXXXXXX'
            });
        }

        const parsedAmount = parseInt(amount, 10);
        if (isNaN(parsedAmount) || parsedAmount < 1 || parsedAmount > 150000) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be between KES 1 and 150,000'
            });
        }

        const token = await getSafaricomToken();
        const { timestamp, password } = getStkCredentials();

        const stkRes = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: parsedAmount,
                PartyA: formattedPhone,
                PartyB: SHORTCODE,
                PhoneNumber: formattedPhone,
                CallBackURL: CALLBACK_URL,
                AccountReference: (clientId || 'BGM').toString().slice(0, 12),
                TransactionDesc: `${service || 'Service'} - ${ward || 'N/A'}`.slice(0, 13)
            },
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 15000
            }
        );

        logTxn('STK_PUSH', {
            phone: formattedPhone,
            amount: parsedAmount,
            service,
            checkoutRequestID: stkRes.data.CheckoutRequestID
        });

        return res.status(200).json({ success: true, ...stkRes.data });

    } catch (err) {
        const safaricomError = err.response?.data;
        logTxn('STK_ERROR', {
            status: err.response?.status,
            error: safaricomError || err.message
        });
        return res.status(502).json({
            success: false,
            error: safaricomError?.errorMessage || 'Payment initiation failed. Please try again.'
        });
    }
});

// ─── Record Cash ──────────────────────────────────────────────────────────────
app.post('/api/cash', (req, res) => {
    const { amount, service, ward, clientId, receipt } = req.body;

    if (!amount) {
        return res.status(400).json({ success: false, error: 'amount is required' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ success: false, error: 'amount must be a positive number' });
    }

    const txn = {
        id: Date.now(),
        type: 'CASH',
        amount: parsedAmount,
        service: service || null,
        ward: ward || null,
        clientId: clientId || null,
        receipt: receipt || 'BGM-' + Date.now(),
        timestamp: new Date().toISOString()
    };

    transactions.push(txn);
    logTxn('CASH', { amount: parsedAmount, service, receipt: txn.receipt });

    return res.status(201).json({ success: true, transaction: txn });
});

// ─── M-Pesa Callback ──────────────────────────────────────────────────────────
app.post('/api/callback', (req, res) => {
    try {
        const cb = req.body?.Body?.stkCallback;

        if (!cb) {
            console.warn('[WARN] /api/callback received malformed body');
            return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
        }

        const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = cb;

        if (ResultCode === 0) {
            const items = CallbackMetadata?.Item || [];
            const get = (name) => items.find(i => i.Name === name)?.Value ?? null;

            const txn = {
                id: Date.now(),
                type: 'MPESA',
                checkoutRequestID: CheckoutRequestID,
                receipt: get('MpesaReceiptNumber'),
                amount: get('Amount'),
                phone: get('PhoneNumber'),
                timestamp: new Date().toISOString()
            };

            transactions.push(txn);
            logTxn('CALLBACK_SUCCESS', txn);
        } else {
            logTxn('CALLBACK_FAILED', { ResultCode, ResultDesc, CheckoutRequestID });
        }

        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });

    } catch (err) {
        console.error('[ERROR] /api/callback threw:', err.message);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    }
});

// ─── Get Transactions ─────────────────────────────────────────────────────────
app.get('/api/transactions', (req, res) => {
    return res.status(200).json({
        success: true,
        count: transactions.length,
        transactions
    });
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[UNHANDLED ERROR]', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[INFO] Bungoma Pay v1_7.0 running on port ${PORT} (${NODE_ENV})`);
});
