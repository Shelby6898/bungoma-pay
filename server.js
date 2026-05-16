require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const moment = require('moment');
const AfricaSTalking = require('africastalking');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ============== FIREBASE ==============
const serviceAccount = require('./firebase-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ============== AFRICASTALKING ==============
const at = AfricaSTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});

// ============== ENV ==============
const MPESA_CONSUMER_KEY = process.env.CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.PASSKEY;
const MPESA_SHORTCODE = process.env.SHORTCODE;
const CALLBACK_URL = process.env.CALLBACK_URL;
const PORT = process.env.PORT || 3000;

const MPESA_ENV = 'sandbox';
const MPESA_BASE_URL = MPESA_ENV === 'sandbox'
 ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

// ============== AUTH MIDDLEWARE ==============
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader ||!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().role!== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access only' });
    }
    req.userData = userDoc.data();
    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ============== M-PESA TOKEN ==============



// ============== M-PESA TOKEN ==============
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
    }
  );

  return response.data.access_token;
}

// ============== SMS ==============
async function sendReceiptSMS(phone, amount, receipt, plate) {
  let formattedPhone = String(phone);

  if (formattedPhone.startsWith('254')) {
    formattedPhone = '+' + formattedPhone;
  }
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '+254' + formattedPhone.slice(1);
  }

  const message = `Bungoma County Revenue: KES ${amount} received for ${plate}. Receipt: ${receipt}. Thank you!`;

  try {
    const result = await at.SMS.send({
      to: [formattedPhone],
      message
    });
    console.log('SMS sent:', result);
  } catch (err) {
    console.log('SMS ERROR:', err.message);
  }
}// ============== TEMP STORAGE ==============
const pendingTransactions = {};

// ============== ROUTES ==============

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/login.html');
});

// Get current user info
app.get('/api/me', verifyToken, async (req, res) => {
  const userDoc = await db.collection('users').doc(req.user.uid).get();
  res.json({
    success: true,
    user: {
      uid: req.user.uid,
      email: req.user.email,
     ...userDoc.data()
    }
  });
});

// Initiate STK Push
app.post('/api/pay', verifyToken, async (req, res) => {
  try {
    const { phone, amount, plate, ward, revenueType } = req.body;

    if (!phone ||!amount ||!plate) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    let formattedPhone = String(phone);
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    }
    if (formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.substring(1);
    }

    const token = await getMpesaToken();
    const timestamp = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');


const stkResponse = await axios.post(
  `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
  {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: MPESA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: CALLBACK_URL,
    AccountReference: plate,
    TransactionDesc: revenueType || 'Revenue Payment'
  },
  { headers: { Authorization: `Bearer ${token}` } }
);  

const checkoutId = stkResponse.data.CheckoutRequestID;

    pendingTransactions[checkoutId] = {
      plate,
      amount,
      phone: formattedPhone,
      ward,
      revenueType,
      createdBy: req.user.uid,
      createdAt: new Date()
    };

    console.log(`STK SENT | ${plate} | KES${amount} | ${formattedPhone}`);
    res.json({ success: true, message: 'STK Push Sent', checkoutId });

  } catch (error) {
    console.log('STK ERROR:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// M-Pesa Callback
app.post('/api/callback', async (req, res) => {
  try {
    const callback = req.body.Body.stkCallback;
    const resultCode = callback.ResultCode;
    const checkoutId = callback.CheckoutRequestID;
    console.log(`CALLBACK: ${checkoutId} | CODE ${resultCode}`);

    if (resultCode === 0) {
      const items = callback.CallbackMetadata?.Item || [];
      let amount = '', receipt = '', phone = '';
      
      items.forEach(item => {
        if (item.Name === 'Amount') amount = item.Value;
        if (item.Name === 'MpesaReceiptNumber') receipt = item.Value;
        if (item.Name === 'PhoneNumber') phone = item.Value;
      });

      const tx = pendingTransactions[checkoutId];

      const transactionData = {
        amount,
        receipt,
        phone,
        plate: tx?.plate || '',
        ward: tx?.ward || '',
        revenueType: tx?.revenueType || '',
        paymentMethod: 'M-PESA',
        createdBy: tx?.createdBy || '',
        status: 'PAID',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('transactions').add(transactionData);

      await sendReceiptSMS(phone, amount, receipt, tx?.plate || 'Revenue Payment');
      
      console.log(`PAYMENT SUCCESS | ${receipt}`);
      delete pendingTransactions[checkoutId];
    }
    
    return res.json({ success: true });

  } catch (error) {
    console.log('CALLBACK ERROR:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Cash Payment - now uses Firebase Auth
app.post('/api/cash', verifyToken, async (req, res) => {
  try {
    const { amount, plate, ward, revenueType } = req.body;

    const receipt = 'CASH-' + Date.now();
    await db.collection('transactions').add({
      amount,
      plate,
      ward,
      revenueType,
      paymentMethod: 'CASH',
      receipt,
      createdBy: req.user.uid,
      status: 'PAID',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ success: true, receipt });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get Transactions
app.get('/api/transactions', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('transactions')
     .orderBy('createdAt', 'desc')
     .limit(50)
     .get();

    const transactions = [];
    snapshot.forEach(doc => {
      transactions.push({ id: doc.id,...doc.data() });
    });
    
    return res.json(transactions);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Stats
app.get('/api/admin/stats', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('transactions').get();

    let totalRevenue = 0;
    snapshot.forEach(doc => {
      totalRevenue += Number(doc.data().amount || 0);
    });

    res.json({
      success: true,
      totalTransactions: snapshot.size,
      totalRevenue
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// START
app.listen(PORT, () => {
  console.log(`Bungoma Pay v2.0 running on port ${PORT}`);
  console.log(`Callback URL: ${CALLBACK_URL}`);
});
