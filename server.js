const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express        = require('express');
const crypto = require('crypto');
const axios          = require('axios');
const helmet         = require('helmet');
const { rateLimit } = require('express-rate-limit');
const moment         = require('moment');
const AfricasTalking = require('africastalking');
const admin          = require('firebase-admin');
const { cert }       = require('firebase-admin/app');
const { getAuth }    = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const locationData   = require('./location-data');
const { createMpesaCallbackProcessor } = require('./mpesa-callback-processor');
const { createMpesaCallbackRecovery } = require('./mpesa-callback-recovery');
const { createAnalyticsAggregateUpdater } = require('./analytics-aggregates');
const { createAdminStatsHandler } = require('./admin-stats-handler');
const { serializeOfficerBroadcast } = require('./broadcast-response');
const { mergeWardReportDocs } = require('./transaction-ward');
const { createMpesaPaymentIntents } = require('./mpesa-payment-intents');
const { createApiNotFoundHandler, createHttpErrorHandler } = require('./http-error-handlers');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: req => req.path === '/callback'
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment requests. Please try again later.' }
});

const cashLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many cash submissions. Please try again later.' }
});

const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// React admin dashboard
const dashboardDist = path.join(__dirname, 'client', 'dist');
app.use('/dashboard', express.static(dashboardDist, { index: false, redirect: false }));
app.get('/dashboard', (req, res, next) => {
  if (req.path === '/dashboard') {
    return res.redirect(301, '/dashboard/');
  }
  next();
});
app.get('/dashboard/', (req, res) => {
  res.sendFile(path.join(dashboardDist, 'index.html'));
});
// ============== FIREBASE ==============
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./firebase-key.json');
admin.initializeApp({
  credential: cert(serviceAccount),
  projectId: serviceAccount.project_id
});
const db   = getFirestore();
const {
  reserveMpesaIntent,
  claimMpesaSubmission
} = createMpesaPaymentIntents({ db, FieldValue });
const auth = getAuth();
const applyAnalyticsAggregates = createAnalyticsAggregateUpdater({
  db,
  FieldValue: FieldValue
});

// ============== AFRICA'S TALKING ==============
let at;
try {
  at = AfricasTalking({
    apiKey:   process.env.AT_API_KEY || 'sandbox',
    username: process.env.AT_USERNAME || 'sandbox'
  });
} catch(e) {
  console.warn("Africa's Talking SMS service initialization skipped.");
}

// ============== ENV ==============
const MPESA_CONSUMER_KEY    = process.env.CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const MPESA_PASSKEY         = process.env.PASSKEY;
const MPESA_SHORTCODE       = process.env.SHORTCODE;
const CALLBACK_URL          = process.env.CALLBACK_URL;
const PORT                  = process.env.PORT || 3000;

const MPESA_ENV      = 'sandbox';
const MPESA_BASE_URL = MPESA_ENV === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

// ============== IDEMPOTENCY STORE ==============
// Prevents duplicate STK pushes within 60 seconds
const recentRequests = new Map();

function isDuplicate(key) {
  const last = recentRequests.get(key);
  return last && (Date.now() - last) < 60000;
}
function markRequest(key) {
  recentRequests.set(key, Date.now());
  setTimeout(() => recentRequests.delete(key), 70000);
}

// ============== PENDING TRANSACTIONS ==============

const pendingTransactions = {};

// ============== AUTH MIDDLEWARE ==============
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    req.user = await auth.verifyIdToken(idToken);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access only' });
    }
    req.userData = userDoc.data();
    next();
  } catch {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// Require an officer with a valid administrator-assigned location.
async function requireOfficer(req, res, next) {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(403).json({
        success: false,
        message: 'Officer profile not found. Contact an administrator.'
      });
    }

    const officerData = userDoc.data();

    if (officerData.role !== 'officer') {
      return res.status(403).json({
        success: false,
        message: 'Officer access only'
      });
    }

    if (!locationData.isValidConstituencyWard(
      officerData.constituencyId,
      officerData.wardId
    )) {
      return res.status(403).json({
        success: false,
        message: 'Your constituency and ward assignment is missing or invalid. Contact an administrator.'
      });
    }

    req.userData = officerData;
    next();
  } catch (error) {
    console.error('Officer authorization check failed.');
    return res.status(500).json({
      success: false,
      message: 'Could not verify officer access'
    });
  }
}

// ============== HELPERS ==============
async function getMpesaToken() {
  const b64 = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const r   = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${b64}` },
      timeout: 15000
    }
  );
  return r.data.access_token;
}



async function queryMpesaStk(checkoutId, originalTimestamp) {
  const token = await getMpesaToken();
  const password = Buffer.from(
    `${MPESA_SHORTCODE}${MPESA_PASSKEY}${originalTimestamp}`
  ).toString('base64');

  const response = await axios.post(
    `${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: originalTimestamp,
      CheckoutRequestID: checkoutId
    },
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    }
  );

  return response.data;
}

const processMpesaCallback = createMpesaCallbackProcessor({
  db,
  applyAnalyticsAggregates,
  queryMpesaStk,
  pendingTransactions,
  serverTimestamp: () => FieldValue.serverTimestamp()
});

const mpesaCallbackRecovery = createMpesaCallbackRecovery({
  db,
  processMpesaCallback,
  Timestamp,
  batchSize: 20,
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  leaseMs: 2 * 60_000,
  intervalMs: 30_000
});

async function sendReceiptSMS(phone, amount, receipt, plate) {
  if (!at) return; // skip if AT not initialized

  let p = String(phone);
  if (p.startsWith('254')) p = '+' + p;
  if (p.startsWith('0'))   p = '+254' + p.slice(1);
  const msg = `Bungoma County Revenue: KES ${amount} received for ${plate}. Receipt: ${receipt}. Thank you!`;
  try {
    await at.SMS.send({ to: [p], message: msg });
  } catch (e) {
    console.error('Receipt SMS delivery failed.');
  }
}
async function getOfficerData(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? doc.data() : {};
}

// ============== ROUTES ==============

app.get('/', (req, res) => {
  res.redirect(302, '/dashboard/');
});
// Current user info
app.get('/api/me', verifyToken, async (req, res) => {
  const doc = await db.collection('users').doc(req.user.uid).get();
  res.json({ success: true, user: { uid: req.user.uid, email: req.user.email, ...doc.data() } });
});

// Heartbeat — officer presence
app.post('/api/heartbeat', verifyToken, async (req, res) => {
  await db.collection('users').doc(req.user.uid).update({
    status: 'online', lastSeen: FieldValue.serverTimestamp()
  });
  res.json({ success: true });
});

// Mark offline
app.post('/api/offline', verifyToken, async (req, res) => {
  await db.collection('users').doc(req.user.uid).update({
    status: 'offline', lastSeen: FieldValue.serverTimestamp()
  });
  res.json({ success: true });
});

// ── STK Push ──────────────────────────────────────────────
app.post('/api/pay', paymentLimiter, verifyToken, requireOfficer, async (req, res) => {
  let intentRef = null;
  let attemptRef = null;
  let submissionClaimed = false;
  let providerCheckoutId = null;
  let providerMerchantId = null;

  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'Invalid payment request.' });
    }

    const {
      phone, amount, plate, revenueType, revenueSubType, idempotencyKey
    } = req.body;
    const officerData = req.userData;

    if (
      typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)
    ) {
      return res.status(400).json({
        success: false,
        message: 'A valid payment request identifier is required.'
      });
    }

    const plateValue = typeof plate === 'string' ? plate.trim() : '';
    const phoneValue = typeof phone === 'string'
      ? phone.trim().replace(/[\s-]/g, '')
      : '';
    const phoneMatch = phoneValue.match(/^(?:0([17]\d{8})|\+?254([17]\d{8}))$/);
    const fp = phoneMatch ? `254${phoneMatch[1] || phoneMatch[2]}` : '';

    const amountText = typeof amount === 'number'
      ? String(amount)
      : typeof amount === 'string' ? amount.trim() : '';
    const normalizedAmount = /^\d+$/.test(amountText) ? Number(amountText) : NaN;
    const accountReference = plateValue.replace(/[\s-]/g, '');

    const allowedRevenue = {
      'Parking': ['General Vehicle Parking', 'Bodaboda Parking', 'Enclosed Bus Park'],
      'Market Fee': ['Daily Trader Fee', 'Produce Fee', 'Market Vehicle / Transport Charge'],
      'Cess': ['Maize Cess', 'Coffee / Tea Cess', 'Other Produce Cess'],
      'Business Permit': ['New Permit', 'Renewal', 'Duplicate', 'Transfer']
    };

    if (!plateValue || plateValue.length > 100) {
      return res.status(400).json({ success: false, message: 'Enter a valid plate or client ID.' });
    }

    if (!fp) {
      return res.status(400).json({ success: false, message: 'Enter a valid Kenyan mobile number.' });
    }

    if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 1) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive whole number.' });
    }

    if (!/^[A-Za-z0-9]{1,12}$/.test(accountReference)) {
      return res.status(400).json({
        success: false,
        message: 'Plate/client reference must contain 1-12 letters or numbers (spaces and hyphens are allowed).'
      });
    }

    if (
      !Object.prototype.hasOwnProperty.call(allowedRevenue, revenueType) ||
      !allowedRevenue[revenueType].includes(revenueSubType)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Select a valid revenue stream and charge.'
      });
    }

    const reservation = await reserveMpesaIntent({
      uid: req.user.uid,
      idempotencyKey,
      phone: fp,
      amount: normalizedAmount,
      plate: plateValue,
      revenueType,
      revenueSubType
    });

    intentRef = reservation.ref;
    const savedState = String(reservation.intent.status || '').toUpperCase();

    if (!reservation.created && savedState !== 'RESERVED') {
      if (savedState === 'PENDING' && reservation.intent.checkoutRequestId) {
        return res.json({
          success: true,
          alreadySubmitted: true,
          message: 'This payment request was already submitted.',
          checkoutId: reservation.intent.checkoutRequestId
        });
      }

      if (['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(savedState)) {
        return res.status(202).json({
          success: false,
          state: savedState,
          message: 'The previous submission may have reached Safaricom. Do not create a new payment request; this one needs status verification.'
        });
      }

      return res.status(409).json({
        success: false,
        state: savedState,
        message: 'This payment request is already in a terminal or review state. Do not resubmit it.'
      });
    }

    // Obtain credentials before claiming the one-time submission.
    const token = await getMpesaToken();
    const ts = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(
      `${MPESA_SHORTCODE}${MPESA_PASSKEY}${ts}`
    ).toString('base64');

    const claim = await claimMpesaSubmission(intentRef, {
      idempotencyKey,
      accountReference,
      mpesaTimestamp: ts
    });

    if (!claim.claimed) {
      if (claim.state === 'PENDING' && claim.checkoutId) {
        return res.json({
          success: true,
          alreadySubmitted: true,
          message: 'This payment request was already submitted.',
          checkoutId: claim.checkoutId
        });
      }

      const uncertain = ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(claim.state);
      return res.status(uncertain ? 202 : 409).json({
        success: false,
        state: claim.state,
        message: uncertain
          ? 'The previous submission may have reached Safaricom. Do not retry with a new request.'
          : 'This payment request cannot be submitted again.'
      });
    }

    submissionClaimed = true;
    attemptRef = claim.attemptRef;

    const stkRes = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: normalizedAmount,
        PartyA: fp,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: fp,
        CallBackURL: CALLBACK_URL,
        AccountReference: accountReference,
        TransactionDesc: 'Revenue'
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000
      }
    );

    providerCheckoutId = stkRes.data?.CheckoutRequestID || null;
    providerMerchantId = stkRes.data?.MerchantRequestID || null;

    if (
      typeof providerCheckoutId !== 'string' ||
      !providerCheckoutId ||
      providerCheckoutId.length > 200 ||
      typeof providerMerchantId !== 'string' ||
      !providerMerchantId ||
      providerMerchantId.length > 200
    ) {
      throw new Error('Safaricom response did not contain valid request identifiers.');
    }

    const tx = {
      checkoutRequestId: providerCheckoutId,
      merchantRequestId: providerMerchantId,
      mpesaTimestamp: ts,
      plate: plateValue,
      amount: normalizedAmount,
      phone: fp,
      revenueType,
      revenueSubType,
      ward: officerData.wardName || '',
      constituencyId: officerData.constituencyId || '',
      constituencyName: officerData.constituencyName || '',
      wardId: officerData.wardId || '',
      wardName: officerData.wardName || '',
      createdBy: req.user.uid,
      officerUsername: officerData.username || officerData.name || req.user.email,
      paymentMethod: 'M-PESA',
      status: 'PENDING',
  analyticsApplied: true,
      createdAt: FieldValue.serverTimestamp()
    };

    const txRef = db.collection('transactions').doc(providerCheckoutId);

    // Link the provider request and transaction atomically.
    await db.runTransaction(async transaction => {
      const intentSnap = await transaction.get(intentRef);
      const txSnap = await transaction.get(txRef);
      const attemptSnap = await transaction.get(attemptRef);

      if (!intentSnap.exists) {
        throw new Error('Payment intent disappeared before transaction linking.');
      }

      if (txSnap.exists) {
        throw new Error('Safaricom checkout identifier already exists.');
      }

      const currentIntent = intentSnap.data();
      if (currentIntent.status !== 'SUBMITTING') {
        throw new Error('Payment intent is not in the expected submission state.');
      }

      if (
        !attemptSnap.exists ||
        attemptSnap.data().status !== 'SUBMITTING' ||
        attemptSnap.data().intentId !== intentRef.id ||
        intentSnap.data().activeAttemptId !== attemptRef.id
      ) {
        throw new Error('Payment attempt is not in the expected submission state.');
      }

      transaction.create(txRef, tx);
      await applyAnalyticsAggregates(transaction, {
      current: tx,
      created: true
    });
transaction.update(intentRef, {
        status: 'PENDING',
        checkoutRequestId: providerCheckoutId,
        merchantRequestId: providerMerchantId,
        mpesaTimestamp: ts,
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      transaction.update(attemptRef, {
        status: 'LINKED',
        checkoutRequestId: providerCheckoutId,
        merchantRequestId: providerMerchantId,
        linkedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    pendingTransactions[providerCheckoutId] = tx;

    await processMpesaCallback(providerCheckoutId).catch(error => {
      console.error('Retained M-PESA callback replay deferred');
    });

    console.log(
      `\n=== STK SENT === KES${normalizedAmount} | Phone:${fp.slice(0, 3)}****${fp.slice(-3)}\n`
    );

    return res.json({
      success: true,
      message: 'STK Push Sent',
      checkoutId: providerCheckoutId
    });
  } catch (error) {
    const errorCode = ({
      ECONNABORTED: 'REQUEST_TIMEOUT',
      ETIMEDOUT: 'REQUEST_TIMEOUT',
      ECONNRESET: 'CONNECTION_RESET',
      ENOTFOUND: 'NETWORK_DNS_ERROR',
      ECONNREFUSED: 'CONNECTION_REFUSED',
      ERR_BAD_RESPONSE: 'PROVIDER_BAD_RESPONSE'
    })[error.code] || (
      error.response?.status ? 'PROVIDER_HTTP_ERROR' : 'REQUEST_ERROR'
    );

    console.warn('M-PESA STK submission error:', {
      category: errorCode,
      httpStatus: Number.isInteger(error.response?.status)
        ? error.response.status
        : null
    });

    if (submissionClaimed && intentRef && attemptRef) {

      const recovery = await db.runTransaction(async transaction => {
        const intentSnap = await transaction.get(intentRef);
        const attemptSnap = await transaction.get(attemptRef);

        if (!intentSnap.exists || !attemptSnap.exists) {
          return { updated: false };
        }

        const currentIntent = intentSnap.data();
        const currentAttempt = attemptSnap.data();

        if (
          currentIntent.status !== 'SUBMITTING' ||
          currentAttempt.status !== 'SUBMITTING' ||
          currentIntent.activeAttemptId !== attemptRef.id
        ) {
          return {
            updated: false,
            intentStatus: currentIntent.status,
            attemptStatus: currentAttempt.status
          };
        }

        if (intentSnap.exists) {
          transaction.update(intentRef, {
            status: 'SUBMISSION_UNKNOWN',
            checkoutRequestId: providerCheckoutId,
            merchantRequestId: providerMerchantId,
            lastSubmissionErrorCode: errorCode,
            updatedAt: FieldValue.serverTimestamp()
          });
        }

        if (attemptSnap.exists) {
          transaction.update(attemptRef, {
            status: 'SUBMISSION_UNKNOWN',
            checkoutRequestId: providerCheckoutId,
            merchantRequestId: providerMerchantId,
            errorCode,
            updatedAt: FieldValue.serverTimestamp()
          });
        }

        return { updated: true };
      }).catch(updateError => {
        console.error('Could not persist uncertain M-PESA submission state.');
        return null;
      });

      if (
        recovery &&
        recovery.intentStatus === 'PENDING' &&
        recovery.attemptStatus === 'LINKED'
      ) {
        return res.json({
          success: true,
          message: 'STK Push Sent',
          checkoutId: providerCheckoutId
        });
      }

      return res.status(202).json({
        success: false,
        state: 'SUBMISSION_UNKNOWN',
        message: 'Safaricom submission could not be confirmed. Do not retry this payment as a new request; it requires status verification.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Could not prepare the payment request. No STK submission was attempted.'
    });
  }
});

// ── M-Pesa Callback ───────────────────────────────────────

// --- M-Pesa Callback ---

// Shared, verified M-PESA callback processor.
// Both early-callback replay and normal callback delivery use this function.

app.post('/api/callback', callbackLimiter, async (req, res) => {
  let callbackRetained = false;

  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'No callback data'
      });
    }

    const checkoutId = callback.CheckoutRequestID;
    const callbackMerchantId = String(callback.MerchantRequestID || '');
    const rawResultCode = callback.ResultCode;
    const resultCode =
      typeof rawResultCode === 'number'
        ? rawResultCode
        : typeof rawResultCode === 'string' && /^\d+$/.test(rawResultCode.trim())
          ? Number(rawResultCode.trim())
          : NaN;

    if (
      typeof checkoutId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(checkoutId) ||
      !Number.isSafeInteger(resultCode) ||
      resultCode < 0
    ) {
      console.log('Invalid M-PESA callback identifiers');
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Accepted'
      });
    }

    const items = callback.CallbackMetadata?.Item || [];
    let callbackAmount = '';
    let receipt = '';

    items.forEach(item => {
      if (item.Name === 'Amount') callbackAmount = item.Value;
      if (item.Name === 'MpesaReceiptNumber') receipt = item.Value;
    });

    const inboxRef = db.collection('mpesa_callback_inbox').doc(checkoutId);
    const inboxData = {
      checkoutRequestId: checkoutId,
      merchantRequestId: callbackMerchantId,
      resultCode,
      amount: callbackAmount === '' ? '' : String(callbackAmount),
      receipt: typeof receipt === 'string' ? receipt.slice(0, 64) : '',
      receivedAt: FieldValue.serverTimestamp(),
    attemptCount: 0,
    nextAttemptAt: Timestamp.fromMillis(Date.now()),
    retryExhausted: false
    };

    await db.runTransaction(async firestoreTx => {
      const inboxSnap = await firestoreTx.get(inboxRef);

      if (!inboxSnap.exists) {
        firestoreTx.create(inboxRef, {
          ...inboxData,
          status: 'RECEIVED'
        });
        return;
      }

      const saved = inboxSnap.data();
      const sameCallback =
        saved.merchantRequestId === inboxData.merchantRequestId &&
        saved.resultCode === inboxData.resultCode &&
        saved.amount === inboxData.amount &&
        saved.receipt === inboxData.receipt;

      if (!sameCallback && saved.status !== 'PROCESSED') {
        firestoreTx.update(inboxRef, {
          status: 'CONFLICT',
          conflictDetectedAt: FieldValue.serverTimestamp()
        });
      }
    });

    callbackRetained = true;

    const processed = await processMpesaCallback(checkoutId);
    console.log('M-PESA callback processing state:', processed.state);

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  } catch (error) {
    console.error('M-PESA callback handler failed; callback retained:', callbackRetained);

    if (!callbackRetained) {
      return res.status(500).json({
        ResultCode: 1,
        ResultDesc: 'Callback could not be durably retained'
      });
    }

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Callback retained; processing deferred if necessary'
    });
  }
});

// ── Cash Payment ──────────────────────────────────────────
app.post('/api/cash', cashLimiter, verifyToken, requireOfficer, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Invalid cash payment request.' });
    }

    const { amount, plate, revenueType, revenueSubType, idempotencyKey } = req.body;
    const officerData = req.userData;

    if (typeof idempotencyKey !== 'string' || !/^[a-f0-9-]{36}$/i.test(idempotencyKey)) {
      return res.status(400).json({ success: false, error: 'Invalid payment request identifier.' });
    }

    const plateValue = typeof plate === 'string' ? plate.trim() : '';
    const amountText = typeof amount === 'number'
      ? String(amount)
      : typeof amount === 'string' ? amount.trim() : '';
    const normalizedAmount = /^\d+$/.test(amountText) ? Number(amountText) : NaN;

    const allowedRevenue = {
      'Parking': ['General Vehicle Parking', 'Bodaboda Parking', 'Enclosed Bus Park'],
      'Market Fee': ['Daily Trader Fee', 'Produce Fee', 'Market Vehicle / Transport Charge'],
      'Cess': ['Maize Cess', 'Coffee / Tea Cess', 'Other Produce Cess'],
      'Business Permit': ['New Permit', 'Renewal', 'Duplicate', 'Transfer']
    };

    if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 1) {
      return res.status(400).json({ success: false, error: 'Amount must be a positive whole number.' });
    }

    if (!plateValue || plateValue.length > 100) {
      return res.status(400).json({ success: false, error: 'Enter a valid plate or client ID.' });
    }

    if (
      !Object.prototype.hasOwnProperty.call(allowedRevenue, revenueType) ||
      !allowedRevenue[revenueType].includes(revenueSubType)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Select a valid revenue stream and charge.'
      });
    }

    const recordId = crypto.createHash('sha256')
      .update(`${req.user.uid}:cash:${idempotencyKey}`)
      .digest('hex');

    const ref = db.collection('transactions').doc(recordId);

    const receipt = await db.runTransaction(async transaction => {
      const existing = await transaction.get(ref);

      if (existing.exists) {
        const saved = existing.data();

        const sameRequest =
          saved.createdBy === req.user.uid &&
          saved.amount === normalizedAmount &&
          saved.plate === plateValue &&
          saved.revenueType === revenueType &&
          saved.revenueSubType === revenueSubType;

        if (!sameRequest) {
          const conflict = new Error('Payment identifier conflict.');
          conflict.code = 'PAYMENT_IDEMPOTENCY_CONFLICT';
          throw conflict;
        }

        return saved.receipt;
      }

      const newReceipt = 'CASH-' + Date.now();

      const cashTransaction = {
        amount: normalizedAmount,
        plate: plateValue,
        ward: officerData.wardName || '',
        constituencyId: officerData.constituencyId,
        constituencyName: officerData.constituencyName,
        wardId: officerData.wardId,
        wardName: officerData.wardName,
        revenueType,
        revenueSubType,
        paymentMethod: 'CASH',
        receipt: newReceipt,
        idempotencyKey,
        createdBy: req.user.uid,
        officerUsername: officerData.username || officerData.name || req.user.email,
        status: 'PAID',
        createdAt: FieldValue.serverTimestamp(),
        analyticsApplied: true
      };
      transaction.create(ref, cashTransaction);
      await applyAnalyticsAggregates(transaction, {
        current: cashTransaction,
        created: true
      });

      return newReceipt;
    });

    res.json({ success: true, receipt });
  } catch (error) {
    console.error('Cash payment request failed.');
    const isConflict = error.code === 'PAYMENT_IDEMPOTENCY_CONFLICT';
    res.status(isConflict ? 409 : 500).json({
      success: false,
      error: isConflict
        ? 'This payment identifier belongs to a different request.'
        : 'Could not record cash payment.'
    });
  }
});

// ── Get Transactions (scoped by role) ─────────────────────
app.get('/api/transactions', verifyToken, async (req, res) => {
  try {
    const userData = await getOfficerData(req.user.uid);
    const isAdmin  = userData.role === 'admin';

    let snapshot;
    if (isAdmin) {
      snapshot = await db.collection('transactions')
        .orderBy('createdAt', 'desc').limit(100).get();
    } else {
      // Officer sees ONLY their own transactions
      snapshot = await db.collection('transactions')
        .where('createdBy', '==', req.user.uid)
        .orderBy('createdAt', 'desc').limit(50).get();
    }

    const transactions = [];
    snapshot.forEach(doc => transactions.push({ id: doc.id, ...doc.data() }));
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not load transactions.' });
  }
});

// ── Admin: Pending M-PESA Payments (read-only) ─────────────
app.get('/api/admin/mpesa/pending', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('transactions')
      .where('status', '==', 'PENDING')
      .where('paymentMethod', '==', 'M-PESA')
      .orderBy('createdAt', 'asc')
      .limit(100)
      .get();

    const payments = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const phone = String(data.phone || '');
      const maskedPhone = phone.length >= 7
        ? `${phone.slice(0, 3)}****${phone.slice(-3)}`
        : 'Unavailable';

      const createdAt = data.createdAt &&
        typeof data.createdAt.toDate === 'function'
        ? data.createdAt.toDate().toISOString()
        : null;

      payments.push({
        checkoutId: doc.id,
        merchantRequestId: String(data.merchantRequestId || ''),
        amount: Number.isSafeInteger(Number(data.amount)) &&
          Number(data.amount) > 0
          ? Number(data.amount)
          : null,
        phone: maskedPhone,
        plate: String(data.plate || ''),
        revenueType: String(data.revenueType || ''),
        revenueSubType: String(data.revenueSubType || ''),
        wardName: String(data.wardName || ''),
        createdAt
      });
    });

    return res.json({
      success: true,
      count: payments.length,
      payments
    });
  } catch (error) {
    console.error('Pending M-PESA list request failed.');
    return res.status(500).json({
      success: false,
      error: 'Could not load pending M-PESA payments.'
    });
  }
});


// ── Admin: Safely reconcile a pending M-PESA payment ─────────
app.post('/api/admin/mpesa/reconcile', verifyToken, requireAdmin, async (req, res) => {
  try {
    const checkoutId = typeof req.body?.checkoutId === 'string'
      ? req.body.checkoutId.trim()
      : '';

    if (!checkoutId || checkoutId.length > 200 || checkoutId.includes('/')) {
      return res.status(400).json({
        success: false,
        error: 'A valid checkoutId is required.'
      });
    }

    const ref = db.collection('transactions').doc(checkoutId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({
        success: false,
        error: 'M-PESA transaction not found.'
      });
    }

    const attempt = snap.data();
    const status = String(attempt.status || '').toUpperCase();

    if (status !== 'PENDING') {
      return res.status(409).json({
        success: false,
        error: 'Only pending payments can be reconciled.',
        currentStatus: status || 'UNKNOWN'
      });
    }

    if (
      attempt.paymentMethod !== 'M-PESA' ||
      !attempt.mpesaTimestamp ||
      !attempt.merchantRequestId
    ) {
      return res.status(409).json({
        success: false,
        error: 'Required original M-PESA verification data is missing.'
      });
    }

    const queryData = await queryMpesaStk(
      checkoutId,
      attempt.mpesaTimestamp
    );

    const rawResultCode = queryData?.ResultCode;
    const resultCode = typeof rawResultCode === 'number'
      ? rawResultCode
      : typeof rawResultCode === 'string' &&
          /^\d+$/.test(rawResultCode.trim())
        ? Number(rawResultCode.trim())
        : NaN;

    const verified = (
      String(queryData?.ResponseCode) === '0' &&
      String(queryData?.CheckoutRequestID || '') === checkoutId &&
      String(queryData?.MerchantRequestID || '') ===
        String(attempt.merchantRequestId) &&
      Number.isSafeInteger(resultCode) &&
      resultCode >= 0
    );

    const logRef = db.collection('mpesa_reconciliation_logs').doc();

    if (!verified) {
      const auditResult = await db.runTransaction(async firestoreTx => {
        const currentSnap = await firestoreTx.get(ref);

        let auditOutcome = 'INCONCLUSIVE';

        if (!currentSnap.exists) {
          auditOutcome = 'NOT_FOUND';
        } else {
          const current = currentSnap.data();
          const currentStatus = String(current.status || '').toUpperCase();

          if (currentStatus !== 'PENDING') {
            auditOutcome = 'STATE_CHANGED';
          } else if (
            current.paymentMethod !== 'M-PESA' ||
            String(current.merchantRequestId || '') !==
              String(attempt.merchantRequestId) ||
            String(current.mpesaTimestamp || '') !==
              String(attempt.mpesaTimestamp)
          ) {
            auditOutcome = 'IDENTIFIERS_CHANGED';
          } else {
            const currentAmount = Number(current.amount);
            const attemptAmount = Number(attempt.amount);

            if (
              !Number.isSafeInteger(currentAmount) ||
              !Number.isSafeInteger(attemptAmount) ||
              currentAmount < 1 ||
              attemptAmount < 1 ||
              currentAmount !== attemptAmount
            ) {
              auditOutcome = 'AMOUNT_MISMATCH';
            }
          }
        }

        firestoreTx.set(logRef, {
          checkoutId,
          outcome: auditOutcome,
          requestedBy: req.user.uid,
          createdAt: FieldValue.serverTimestamp()
        });

        return auditOutcome;
      });

      return res.status(auditResult === 'NOT_FOUND' ? 404 : 200).json({
        success: auditResult !== 'NOT_FOUND',
        paymentStatusChanged: false,
        outcome: auditResult,
        message: auditResult === 'INCONCLUSIVE'
          ? 'Verification was inconclusive. Transaction remains unchanged.'
          : 'Transaction was not changed. Review the reconciliation audit.'
      });
    }

    const outcome = resultCode === 0
      ? 'SUCCESS_REQUIRES_CALLBACK_EVIDENCE'
      : 'VERIFIED_FAILURE';

    const result = await db.runTransaction(async firestoreTx => {
      const currentSnap = await firestoreTx.get(ref);

      if (!currentSnap.exists) {
        firestoreTx.set(logRef, {
          checkoutId,
          outcome: 'NOT_FOUND',
          requestedBy: req.user.uid,
          createdAt: FieldValue.serverTimestamp()
        });

        return { changed: false, state: 'NOT_FOUND' };
      }

      const current = currentSnap.data();
      const currentStatus = String(current.status || '').toUpperCase();

      if (currentStatus !== 'PENDING') {
        firestoreTx.set(logRef, {
          checkoutId,
          outcome: 'STATE_CHANGED',
          currentStatus: currentStatus || 'UNKNOWN',
          requestedBy: req.user.uid,
          createdAt: FieldValue.serverTimestamp()
        });

        return {
          changed: false,
          state: currentStatus || 'UNKNOWN'
        };
      }

      if (
        current.paymentMethod !== 'M-PESA' ||
        String(current.merchantRequestId || '') !==
          String(attempt.merchantRequestId) ||
        String(current.mpesaTimestamp || '') !==
          String(attempt.mpesaTimestamp)
      ) {
        firestoreTx.set(logRef, {
          checkoutId,
          outcome: 'IDENTIFIERS_CHANGED',
          requestedBy: req.user.uid,
          createdAt: FieldValue.serverTimestamp()
        });

        return {
          changed: false,
          state: 'IDENTIFIERS_CHANGED'
        };
      }

      const currentAmount = Number(current.amount);
      const attemptAmount = Number(attempt.amount);

      if (
        !Number.isSafeInteger(currentAmount) ||
        !Number.isSafeInteger(attemptAmount) ||
        currentAmount < 1 ||
        attemptAmount < 1 ||
        currentAmount !== attemptAmount
      ) {
        firestoreTx.set(logRef, {
          checkoutId,
          outcome: 'AMOUNT_MISMATCH',
          requestedBy: req.user.uid,
          createdAt: FieldValue.serverTimestamp()
        });

        return {
          changed: false,
          state: 'AMOUNT_MISMATCH'
        };
      }

      if (resultCode !== 0) {
        const updated = {
          status: 'FAILED',
          paymentMethod: 'M-PESA',
          failureCode: resultCode,
          failureDescription: String(
            queryData.ResultDesc || 'M-PESA payment failed'
          ),
          reconciliationOutcome: outcome,
          reconciledAt: FieldValue.serverTimestamp(),
          completedAt: FieldValue.serverTimestamp()
        };

        firestoreTx.set(ref, updated, { merge: true });

        if (current.analyticsApplied === true) {
          await applyAnalyticsAggregates(firestoreTx, {
            previous: current,
            current: { ...current, ...updated }
          });
        }
      } else {
        // STK Query success alone does not supply the callback amount
        // and receipt evidence required by this application's PAID flow.
        firestoreTx.set(ref, {
          reconciliationOutcome: outcome,
          reconciledAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }

      firestoreTx.set(logRef, {
        checkoutId,
        merchantRequestId: String(attempt.merchantRequestId),
        outcome,
        resultCode,
        requestedBy: req.user.uid,
        createdAt: FieldValue.serverTimestamp()
      });

      return {
        changed: true,
        state: resultCode === 0 ? 'PENDING' : 'FAILED'
      };
    });

    if (result.state === 'NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: 'Transaction no longer exists.'
      });
    }

    if (!result.changed) {
      return res.status(409).json({
        success: false,
        error: 'Transaction state changed during reconciliation.',
        currentStatus: result.state
      });
    }

    if (result.state === 'FAILED') {
      delete pendingTransactions[checkoutId];
    }

    return res.json({
      success: true,
      paymentStatusChanged: result.state === 'FAILED',
      outcome,
      status: result.state,
      message: result.state === 'FAILED'
        ? 'Verified failure recorded.'
        : 'STK Query reports success, but callback payment evidence is still required. Transaction remains pending.'
    });
  } catch (error) {
    console.error('M-PESA reconciliation request failed.');
    return res.status(502).json({
      success: false,
      error: 'Reconciliation could not be completed. Transaction was not automatically marked as paid.'
    });
  }
});

// ── Admin Stats ────────────────────────────────────────────
app.get(
  '/api/admin/stats',
  verifyToken,
  requireAdmin,
  createAdminStatsHandler({ db })
);

// ── Seven-day Revenue Trend ─────────────────────────────────

app.get('/api/admin/revenue-trend', verifyToken, requireAdmin, async (req, res) => {
  try {
    const timeZone = 'Africa/Nairobi';

    const todayParts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());

    const parts = Object.fromEntries(
      todayParts.map(part => [part.type, part.value])
    );

    const todayKey = `${parts.year}-${parts.month}-${parts.day}`;
    const [year, month, day] = todayKey.split('-').map(Number);
    const todayUtc = new Date(Date.UTC(year, month - 1, day));
    const nairobiMidnightUtc = new Date(todayUtc.getTime() - 3 * 60 * 60 * 1000);
    const rangeStart = new Date(nairobiMidnightUtc.getTime() - 6 * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(nairobiMidnightUtc.getTime() + 24 * 60 * 60 * 1000);

    const days = [];

    for (let i = 6; i >= 0; i--) {
      const date = new Date(todayUtc);
      date.setUTCDate(date.getUTCDate() - i);

      const key = date.toISOString().slice(0, 10);
      const label = new Intl.DateTimeFormat('en-KE', {
        timeZone,
        weekday: 'short'
      }).format(new Date(`${key}T12:00:00Z`));

      days.push({ date: key, label, total: 0 });
    }

    const dayTotals = new Map(days.map(day => [day.date, day]));
    const snapshot = await db.collection('transactions')
      .where('status', '==', 'PAID')
      .where('createdAt', '>=', rangeStart)
      .where('createdAt', '<', rangeEnd)
      .orderBy('createdAt', 'asc')
      .get();

    snapshot.forEach(doc => {
      const transaction = doc.data();
      const createdAt = transaction.createdAt;

      const transactionDate = createdAt?.toDate
        ? createdAt.toDate()
        : createdAt?._seconds
          ? new Date(createdAt._seconds * 1000)
          : createdAt
            ? new Date(createdAt)
            : null;

      if (!transactionDate || Number.isNaN(transactionDate.getTime())) return;

      const dateKey = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(transactionDate);

      const dayEntry = dayTotals.get(dateKey);
      if (dayEntry) {
        const amount = Number(transaction.amount);
        if (Number.isSafeInteger(amount) && amount > 0) {
          dayEntry.total += amount;
        }
      }
    });

    const totalRevenue = days.reduce((sum, day) => sum + day.total, 0);

    res.json({ success: true, days, totalRevenue });
  } catch (error) {
    console.error('Revenue trend request failed.');
    res.status(500).json({
      success: false,
      message: 'Could not load the seven-day revenue trend.'
    });
  }
});

// ── County location data for authorized administrators ───────
app.get('/api/locations', verifyToken, requireAdmin, (req, res) => {
  res.json({
    success: true,
    county: locationData.COUNTY,
    constituencies: locationData.CONSTITUENCIES
  });
});

// ── Create Officer ─────────────────────────────────────────
app.post('/api/create-officer', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { username, email, password, constituencyId, wardId } = req.body;

    if (
      typeof username !== 'string' || !username.trim() ||
      typeof email !== 'string' || !email.trim() ||
      typeof password !== 'string' || password.length < 6 ||
      typeof constituencyId !== 'string' ||
      typeof wardId !== 'string'
    ) {
      return res.status(400).json({
        success: false,
        message: 'Provide a name, valid email, password of at least 6 characters, constituency and ward.'
      });
    }

    const constituency = locationData.getConstituencyById(constituencyId);
    const ward = locationData.getWardById(constituencyId, wardId);

    if (!constituency || !ward) {
      return res.status(400).json({
        success: false,
        message: 'The selected ward does not belong to the selected constituency.'
      });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    const userRecord = await auth.createUser({
      email: cleanEmail,
      password,
      displayName: cleanUsername
    });

    try {
      await db.collection('users').doc(userRecord.uid).set({
        username: cleanUsername,
        email: cleanEmail,
        role: 'officer',
        constituencyId: constituency.id,
        constituencyName: constituency.name,
        wardId: ward.id,
        wardName: ward.name,
        status: 'offline',
        lastSeen: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (profileError) {
      console.error('Officer profile creation failed after Auth account creation.');
      return res.status(500).json({
        success: false,
        message: 'The login account was created, but its officer profile could not be saved. Contact an administrator before retrying.',
        accountCreated: true,
        uid: userRecord.uid
      });
    }

    res.json({
      success: true,
      uid: userRecord.uid,
      message: `Officer ${cleanUsername} created`
    });
  } catch (error) {
    console.error('Officer account creation failed.');
    res.status(500).json({
      success: false,
      message: error.code === 'auth/email-already-exists'
        ? 'An account with this email already exists.'
        : 'Could not create officer account.'
    });
  }
});

// ── Today's Officer Collection Activity ────────────────────
app.get('/api/admin/officer-activity', verifyToken, requireAdmin, async (req, res) => {
  try {
    const timeZone = 'Africa/Nairobi';

    const getDateKey = (date) => new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);

    const todayKey = getDateKey(new Date());
    const [year, month, day] = todayKey.split('-').map(Number);
    const todayUtc = new Date(Date.UTC(year, month - 1, day));
    const dayStart = new Date(todayUtc.getTime() - 3 * 60 * 60 * 1000);
    const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const [officerSnapshot, transactionSnapshot] = await Promise.all([
      db.collection('users').where('role', '==', 'officer').get(),
      db.collection('transactions')
        .where('status', '==', 'PAID')
        .where('createdAt', '>=', dayStart)
        .where('createdAt', '<', nextDay)
        .orderBy('createdAt', 'asc')
        .get()
    ]);

    const officers = new Map();

    officerSnapshot.forEach(doc => {
      const data = doc.data();

      officers.set(doc.id, {
        uid: doc.id,
        username: data.username || data.name || data.email || 'Officer',
        ward: data.wardName || data.ward || 'Unassigned',
        total: 0,
        transactions: 0
      });
    });

    transactionSnapshot.forEach(doc => {
      const transaction = doc.data();
      const createdAt = transaction.createdAt;

      const transactionDate = createdAt?.toDate
        ? createdAt.toDate()
        : createdAt?._seconds
          ? new Date(createdAt._seconds * 1000)
          : createdAt?.seconds
            ? new Date(createdAt.seconds * 1000)
            : createdAt
              ? new Date(createdAt)
              : null;

      if (!transactionDate || Number.isNaN(transactionDate.getTime())) return;
      if (getDateKey(transactionDate) !== todayKey) return;

      const officer = officers.get(transaction.createdBy);
      if (!officer) return;

      const amount = Number(transaction.amount);
      if (!Number.isSafeInteger(amount) || amount < 1) return;

      officer.total += amount;
      officer.transactions++;
    });

    const result = Array.from(officers.values())
      .sort((a, b) => b.total - a.total);

    res.json({ success: true, date: todayKey, officers: result });
  } catch (error) {
    console.error('Officer activity request failed.');
    res.status(500).json({
      success: false,
      message: "Could not load today's officer activity."
    });
  }
});

// ── List Officers ──────────────────────────────────────────
app.get('/api/officers', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users').where('role', '==', 'officer').get();
    const officers = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      officers.push({
        uid: doc.id,
        username: data.username || '',
        email: data.email || '',
        ward: data.wardName || data.ward || '',
        constituencyId: data.constituencyId || '',
        constituencyName: data.constituencyName || '',
        wardId: data.wardId || '',
        wardName: data.wardName || '',
        status: data.status || 'offline',
        lastSeen: data.lastSeen || null
      });
    });
    res.json({ success: true, officers });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not load officers.' });
  }
});

// ── Assign or reassign an officer's county location ─────────
app.put('/api/officers/:uid/location', verifyToken, requireAdmin, async (req, res) => {
  try {
    const uid = req.params.uid;
    const { constituencyId, wardId } = req.body;

    if (
      typeof uid !== 'string' || !uid.trim() ||
      typeof constituencyId !== 'string' ||
      typeof wardId !== 'string'
    ) {
      return res.status(400).json({
        success: false,
        message: 'A valid officer, constituency and ward are required.'
      });
    }

    const constituency = locationData.getConstituencyById(constituencyId);
    const ward = locationData.getWardById(constituencyId, wardId);

    if (!constituency || !ward) {
      return res.status(400).json({
        success: false,
        message: 'The selected ward does not belong to the selected constituency.'
      });
    }

    const officerRef = db.collection('users').doc(uid);
    const officerDoc = await officerRef.get();

    if (!officerDoc.exists || officerDoc.data().role !== 'officer') {
      return res.status(404).json({
        success: false,
        message: 'Officer profile not found.'
      });
    }

    await officerRef.update({
      constituencyId: constituency.id,
      constituencyName: constituency.name,
      wardId: ward.id,
      wardName: ward.name,
      locationUpdatedAt: FieldValue.serverTimestamp(),
      locationUpdatedBy: req.user.uid
    });

    return res.json({
      success: true,
      message: 'Officer location assignment updated.',
      constituencyName: constituency.name,
      wardName: ward.name
    });
  } catch (error) {
    console.error('Officer location assignment failed.');
    return res.status(500).json({
      success: false,
      message: 'Could not update officer location assignment.'
    });
  }
});

// ── Generate Report ────────────────────────────────────────
app.post('/api/report', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { type, startDate, endDate, ward, officerUid } = req.body;
    let query = db.collection('transactions');
    let wardReportDocs = null;

    if (type === 'daily') {
      const s = Timestamp.fromDate(moment(startDate).startOf('day').toDate());
      const e = Timestamp.fromDate(moment(startDate).endOf('day').toDate());
      query = query.where('createdAt', '>=', s).where('createdAt', '<=', e);
    } else if (type === 'weekly' || type === 'monthly') {
      const s = Timestamp.fromDate(moment(startDate).startOf('day').toDate());
      const e = Timestamp.fromDate(moment(endDate).endOf('day').toDate());
      query = query.where('createdAt', '>=', s).where('createdAt', '<=', e);
    } else if (type === 'ward') {
      if (typeof ward !== 'string' || !ward.trim()) {
        return res.status(400).json({ success: false, message: 'A valid ward is required.' });
      }
      const requestedWard = ward.trim();
      const results = await Promise.all([
        db.collection('transactions').where('wardName', '==', requestedWard).get(),
        db.collection('transactions').where('ward', '==', requestedWard).get()
      ]);
      wardReportDocs = mergeWardReportDocs(results[0].docs, results[1].docs, requestedWard);
    } else if (type === 'officer') {
      query = query.where('createdBy', '==', officerUid);
    }

    const reportDocs = wardReportDocs || (await query.orderBy('createdAt', 'desc').get()).docs;
    const transactions = [];
    let totalRevenue = 0, mpesaTotal = 0, cashTotal = 0;
    let paidTransactions = 0;
    const statusSummary = {
      PAID: { transactions: 0, attemptedAmount: 0 },
      PENDING: { transactions: 0, attemptedAmount: 0 },
      FAILED: { transactions: 0, attemptedAmount: 0 },
      OTHER: { transactions: 0, attemptedAmount: 0 }
    };
    const revenueBreakdown = Object.create(null);

    reportDocs.forEach(doc => {
      const d = doc.data();
      transactions.push({ id: doc.id, ...d });

      const amount = Number(d.amount) || 0;
      const rawStatus = String(d.status || '').toUpperCase();
      const status = Object.prototype.hasOwnProperty.call(statusSummary, rawStatus)
        ? rawStatus
        : 'OTHER';

      statusSummary[status].transactions++;
      statusSummary[status].attemptedAmount += amount;

      if (status !== 'PAID') return;
      paidTransactions++;
      totalRevenue += amount;

      const method = String(d.paymentMethod || '').toUpperCase();
      if (method === 'M-PESA') mpesaTotal += amount;
      else if (method === 'CASH') cashTotal += amount;

      const stream = String(d.revenueType || '').trim() || 'Unclassified';
      const subType = String(d.revenueSubType || '').trim() || 'Unspecified';

      if (!revenueBreakdown[stream]) {
        revenueBreakdown[stream] = {
          total: 0,
          transactions: 0,
          subTypes: Object.create(null)
        };
      }

      revenueBreakdown[stream].total += amount;
      revenueBreakdown[stream].transactions++;

      if (!revenueBreakdown[stream].subTypes[subType]) {
        revenueBreakdown[stream].subTypes[subType] = {
          total: 0,
          transactions: 0
        };
      }

      revenueBreakdown[stream].subTypes[subType].total += amount;
      revenueBreakdown[stream].subTypes[subType].transactions++;
    });

    res.json({
      success: true,
      summary: {
        type,
        totalTransactions: transactions.length,
        paidTransactions,
        statusSummary,
        totalRevenue,
        mpesaTotal,
        cashTotal,
        revenueBreakdown,
        generatedAt: new Date().toISOString()
      },
      transactions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not generate report.' });
  }
});

// ── Targeted Broadcasts ─────────────────────────────────────
app.post('/api/broadcast', verifyToken, requireAdmin, async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string'
      ? req.body.message.trim()
      : '';

    if (!message || message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'A message of 1–2000 characters is required.'
      });
    }

    const target = req.body?.target || { scope: 'all' };
    const scope = target.scope || 'all';
    let officers = [];

    if (scope === 'all' || scope === 'constituency' || scope === 'ward') {
      const snapshot = await db.collection('users')
        .where('role', '==', 'officer')
        .get();

      officers = snapshot.docs.map(doc => ({
        uid: doc.id,
        ...doc.data()
      }));

      if (scope === 'constituency') {
        const constituency = locationData.getConstituencyById(target.constituencyId);
        if (!constituency) {
          return res.status(400).json({
            success: false,
            message: 'Select a valid constituency.'
          });
        }

        officers = officers.filter(
          officer => officer.constituencyId === constituency.id
        );
      }

      if (scope === 'ward') {
        const constituency = locationData.getConstituencyById(target.constituencyId);
        const ward = locationData.getWardById(target.constituencyId, target.wardId);

        if (!constituency || !ward) {
          return res.status(400).json({
            success: false,
            message: 'Select a valid constituency and ward.'
          });
        }

        officers = officers.filter(
          officer =>
            officer.constituencyId === constituency.id &&
            officer.wardId === ward.id
        );
      }
    } else if (scope === 'officer') {
      if (typeof target.officerUid !== 'string' || !target.officerUid.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Select a valid officer.'
        });
      }

      const officerDoc = await db.collection('users')
        .doc(target.officerUid.trim())
        .get();

      if (!officerDoc.exists || officerDoc.data().role !== 'officer') {
        return res.status(404).json({
          success: false,
          message: 'The selected officer was not found.'
        });
      }

      officers = [{ uid: officerDoc.id, ...officerDoc.data() }];
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid broadcast target.'
      });
    }

    const recipientUids = [...new Set(officers.map(officer => officer.uid))];

    if (recipientUids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'There are no officers assigned to the selected target.'
      });
    }

    const senderData = await getOfficerData(req.user.uid);

    const broadcast = {
      message,
      senderName: senderData.username || senderData.name || 'Admin',
      senderUid: req.user.uid,
      targetScope: scope,
      targetConstituencyId: scope === 'constituency' || scope === 'ward'
        ? target.constituencyId
        : null,
      targetWardId: scope === 'ward' ? target.wardId : null,
      targetOfficerUid: scope === 'officer' ? target.officerUid.trim() : null,
      recipientUids,
      recipientCount: recipientUids.length,
      readBy: [],
      createdAt: FieldValue.serverTimestamp()
    };

    await db.collection('broadcasts').add(broadcast);

    return res.json({
      success: true,
      message: `Announcement sent to ${recipientUids.length} officer(s).`,
      recipientCount: recipientUids.length
    });
  } catch (error) {
    console.error('Broadcast creation failed.');
    return res.status(500).json({
      success: false,
      message: 'Could not send the announcement.'
    });
  }
});

// Retrieve announcements addressed to the authenticated officer.
app.get('/api/broadcasts', verifyToken, requireOfficer, async (req, res) => {
  try {
    const snapshot = await db.collection('broadcasts')
      .where('recipientUids', 'array-contains', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const broadcasts = snapshot.docs.map(doc =>
      serializeOfficerBroadcast(doc, req.user.uid)
    );

    res.json({ success: true, broadcasts });
  } catch (error) {
    console.error('Broadcast list request failed.');
    res.status(500).json({
      success: false,
      message: 'Could not load announcements.'
    });
  }
});

// Only an intended officer recipient may acknowledge a broadcast.
app.post('/api/broadcast/:id/read', verifyToken, requireOfficer, async (req, res) => {
  try {
    const broadcastRef = db.collection('broadcasts').doc(req.params.id);
    const broadcastDoc = await broadcastRef.get();

    if (!broadcastDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found.'
      });
    }

    const broadcast = broadcastDoc.data();

    if (
      !Array.isArray(broadcast.recipientUids) ||
      !broadcast.recipientUids.includes(req.user.uid)
    ) {
      return res.status(403).json({
        success: false,
        message: 'You are not a recipient of this announcement.'
      });
    }

    await broadcastRef.update({
      readBy: FieldValue.arrayUnion(req.user.uid)
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Broadcast acknowledgement failed.');
    return res.status(500).json({
      success: false,
      message: 'Could not update announcement status.'
    });
  }
});

// ── Update Profile ─────────────────────────────────────────
app.post('/api/profile/update', verifyToken, async (req, res) => {
  try {
    const username = typeof req.body?.username === 'string'
      ? req.body.username.trim()
      : '';

    if (!username) {
      return res.status(400).json({ success: false, error: 'Display name is required' });
    }
    if (username.length > 80) {
      return res.status(400).json({ success: false, error: 'Display name is too long' });
    }

    await db.collection('users').doc(req.user.uid).update({ username });
    await auth.updateUser(req.user.uid, { displayName: username });

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not update profile.' });
  }
});

// ── Sync Offline Transactions ─────────────────────────────
app.post('/api/sync-offline', cashLimiter, verifyToken, requireOfficer, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Invalid sync request.' });
    }

    const { transactions } = req.body;

    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.json({ success: true, synced: 0, skipped: 0 });
    }

    if (transactions.length > 50) {
      return res.status(400).json({ success: false, error: 'Maximum 50 transactions per sync.' });
    }

    const allowedRevenue = {
      'Parking': ['General Vehicle Parking', 'Bodaboda Parking', 'Enclosed Bus Park'],
      'Market Fee': ['Daily Trader Fee', 'Produce Fee', 'Market Vehicle / Transport Charge'],
      'Cess': ['Maize Cess', 'Coffee / Tea Cess', 'Other Produce Cess'],
      'Business Permit': ['New Permit', 'Renewal', 'Duplicate', 'Transfer']
    };

    const validated = [];

    for (const tx of transactions) {
      if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
        return res.status(400).json({ success: false, error: 'Invalid offline transaction.' });
      }

      if (typeof tx.createdBy !== 'string' || tx.createdBy !== req.user.uid) {
        return res.status(403).json({
          success: false,
          error: 'Offline transaction belongs to a different officer. Sign in with the original account.'
        });
      }

      const amountText = typeof tx.amount === 'number'
        ? String(tx.amount)
        : typeof tx.amount === 'string' ? tx.amount.trim() : '';

      const amount = /^\d+$/.test(amountText) ? Number(amountText) : NaN;
      const plate = typeof tx.plate === 'string' ? tx.plate.trim() : '';
      const receipt = typeof tx.receipt === 'string' ? tx.receipt.trim() : '';

      if (!Number.isSafeInteger(amount) || amount < 1) {
        return res.status(400).json({ success: false, error: 'Invalid transaction amount.' });
      }

      if (!plate || plate.length > 100) {
        return res.status(400).json({ success: false, error: 'Invalid plate or client ID.' });
      }

      if (!/^OFFLINE-\d+-[A-Z0-9]{4}$/.test(receipt)) {
        return res.status(400).json({ success: false, error: 'Invalid offline receipt.' });
      }

      if (
        !Object.prototype.hasOwnProperty.call(allowedRevenue, tx.revenueType) ||
        !allowedRevenue[tx.revenueType].includes(tx.revenueSubType)
      ) {
        return res.status(400).json({ success: false, error: 'Invalid revenue category.' });
      }

      validated.push({ amount, plate, receipt, revenueType: tx.revenueType, revenueSubType: tx.revenueSubType });
    }

    const officerData = req.userData;
    let synced = 0;
    let skipped = 0;

    for (const tx of validated) {
      const recordId = crypto
        .createHash('sha256')
        .update(`${req.user.uid}:${tx.receipt}`)
        .digest('hex');

      const ref = db.collection('transactions').doc(recordId);
      const legacyQuery = db.collection('transactions')
        .where('receipt', '==', tx.receipt)
        .limit(1);

      const wasCreated = await db.runTransaction(async transaction => {
        const existing = await transaction.get(ref);

        const matchesSavedPayment = saved =>
          saved.createdBy === req.user.uid &&
          saved.amount === tx.amount &&
          saved.plate === tx.plate &&
          saved.revenueType === tx.revenueType &&
          saved.revenueSubType === tx.revenueSubType &&
          saved.receipt === tx.receipt &&
          saved.paymentMethod === 'CASH';

        if (existing.exists) {
          if (!matchesSavedPayment(existing.data())) {
            const conflict = new Error('Offline receipt conflict.');
            conflict.code = 'PAYMENT_IDEMPOTENCY_CONFLICT';
            throw conflict;
          }
          return false;
        }

        const legacy = await transaction.get(legacyQuery);
        if (!legacy.empty) {
          if (!matchesSavedPayment(legacy.docs[0].data())) {
            const conflict = new Error('Offline receipt conflict.');
            conflict.code = 'PAYMENT_IDEMPOTENCY_CONFLICT';
            throw conflict;
          }
          return false;
        }

        const offlineTransaction = {
          amount: tx.amount,
          plate: tx.plate,
          ward: officerData.wardName || '',
          constituencyId: officerData.constituencyId,
          constituencyName: officerData.constituencyName,
          wardId: officerData.wardId,
          wardName: officerData.wardName,
          revenueType: tx.revenueType,
          revenueSubType: tx.revenueSubType,
          paymentMethod: 'CASH',
          receipt: tx.receipt,
          createdBy: req.user.uid,
          officerUsername: officerData.username || officerData.name || req.user.email,
          status: 'PAID',
          offlineSync: true,
          createdAt: FieldValue.serverTimestamp(),
          analyticsApplied: true
        };
        transaction.create(ref, offlineTransaction);
        await applyAnalyticsAggregates(transaction, {
          current: offlineTransaction,
          created: true
        });

        return true;
      });

      if (wasCreated) synced++;
      else skipped++;
    }

    res.json({ success: true, synced, skipped });
  } catch (error) {
    console.error('Offline transaction sync failed.');
    const isConflict = error.code === 'PAYMENT_IDEMPOTENCY_CONFLICT';
    res.status(isConflict ? 409 : 500).json({
      success: false,
      error: isConflict
        ? 'This offline receipt conflicts with an existing payment.'
        : 'Could not sync offline transactions.'
    });
  }
});


// Keep API misses and unexpected request failures on a safe JSON contract.
app.use('/api', createApiNotFoundHandler());
app.use(createHttpErrorHandler());

// ============== START ==============
const server = app.listen(PORT, () => {
  console.log(`Bungoma Pay v3.0 running on port ${PORT}`);
  console.log('Callback URL configured:', Boolean(CALLBACK_URL));

  mpesaCallbackRecovery.start();
  console.log('M-PESA callback recovery worker started.');
});

async function shutdown(signal) {
  console.log(`${signal} received. Stopping M-PESA recovery polling...`);

  try {
    await mpesaCallbackRecovery.stop();
  } catch (error) {
    console.error('M-PESA recovery worker shutdown failed.');
    process.exitCode = 1;
  }

  server.close(error => {
    if (error) {
      console.error('HTTP server shutdown failed.');
      process.exitCode = 1;
      return;
    }

    console.log('HTTP server closed.');
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
