
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const moment = require('moment');
const AfricasTalking = require('africastalking');
const admin = require('firebase-admin');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ================= SESSION =================

app.use(session({
  secret: 'bungoma-pay-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// ================= FIREBASE =================

const serviceAccount = require('./firebase-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================= DEFAULT USERS =================

async function createDefaultUsers() {

  const usersRef = db.collection('users');

  const adminDoc = await usersRef.doc('admin').get();

  if (!adminDoc.exists) {

    const hashedPassword = await bcrypt.hash('admin123', 10);

    await usersRef.doc('admin').set({
      username: 'admin',
      password: hashedPassword,
      role: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('Default admin created');
  }

  const officerDoc = await usersRef.doc('officer').get();

  if (!officerDoc.exists) {

    const hashedPassword = await bcrypt.hash('officer123', 10);

    await usersRef.doc('officer').set({
      username: 'officer',
      password: hashedPassword,
      role: 'officer',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('Default officer created');
  }
}

createDefaultUsers();

// ================= AFRICASTALKING =================

const at = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});

// ================= ENV =================

const MPESA_CONSUMER_KEY = process.env.CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.PASSKEY;
const MPESA_SHORTCODE = process.env.SHORTCODE;
const CALLBACK_URL = process.env.CALLBACK_URL;
const PORT = process.env.PORT || 3000;

const MPESA_ENV = 'sandbox';

const MPESA_BASE_URL =
  MPESA_ENV === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke'
    : 'https://api.safaricom.co.ke';

// ================= TOKEN =================

async function getMpesaToken() {

  const auth = Buffer.from(
    `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );

  console.log('TOKEN RESULT =', response.data);

  return response.data.access_token;
}

// ================= SMS =================

async function sendReceiptSMS(phone, amount, receipt, plate) {

  let formattedPhone = String(phone);

  if (formattedPhone.startsWith('254')) {
    formattedPhone = '+' + formattedPhone;
  }

  if (formattedPhone.startsWith('0')) {
    formattedPhone = '+254' + formattedPhone.substring(1);
  }

  const message =
    `Bungoma County Revenue: KES ${amount} received for ${plate}. Receipt: ${receipt}`;

  try {

    const result = await at.SMS.send({
      to: [formattedPhone],
      message
    });

    console.log('SMS sent:', result);

  } catch (err) {

    console.log('SMS ERROR:', err.message);

  }
}

// ================= TEMP STK STORAGE =================

const pendingTransactions = {};

// ================= AUTH =================

function requireAuth(req, res, next) {

  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
  }

  next();
}

function requireAdmin(req, res, next) {

  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
  }

  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access only'
    });
  }

  next();
}

// ================= ROUTES =================

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/login.html');
});

// ================= LOGIN =================

app.post('/api/login', async (req, res) => {

  try {

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password required'
      });
    }

    const userDoc = await db.collection('users')
      .doc(username)
      .get();

    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = userDoc.data();

    const validPassword = await bcrypt.compare(
      password,
      user.password
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    req.session.user = {
      username: user.username,
      role: user.role
    };

    return res.json({
      success: true,
      role: user.role,
      username: user.username
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================= LOGOUT =================

app.post('/api/logout', (req, res) => {

  req.session.destroy(() => {

    return res.json({
      success: true
    });
  });
});

// ================= CURRENT USER =================

app.get('/api/me', requireAuth, (req, res) => {

  return res.json({
    success: true,
    user: req.session.user
  });
});

// ================= PAY =================

app.post('/api/pay', requireAuth, async (req, res) => {

  try {

    const {
      phone,
      amount,
      plate,
      ward,
      revenueType
    } = req.body;

    if (!phone || !amount || !plate) {

      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    let formattedPhone = String(phone);

    if (formattedPhone.startsWith('0')) {
      formattedPhone =
        '254' + formattedPhone.substring(1);
    }

    if (formattedPhone.startsWith('+')) {
      formattedPhone =
        formattedPhone.substring(1);
    }

    const token = await getMpesaToken();

    const timestamp =
      moment().format('YYYYMMDDHHmmss');

    const password = Buffer.from(
      `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const stkResponse = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: CALLBACK_URL,
        AccountReference: plate,
        TransactionDesc: revenueType || 'Revenue Payment'
      },
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const checkoutId =
      stkResponse.data.CheckoutRequestID;

    pendingTransactions[checkoutId] = {
      plate,
      amount,
      phone: formattedPhone,
      ward,
      revenueType,
      createdBy: req.session.user.username,
      createdAt: new Date()
    };

    console.log(
      `STK SENT | ${plate} | KES${amount} | ${formattedPhone}`
    );

    return res.json({
      success: true,
      message: 'STK Push Sent'
    });

  } catch (error) {

    console.log(
      'STK ERROR:',
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================= CALLBACK =================

app.post('/api/callback', async (req, res) => {

  try {

    const callback =
      req.body.Body.stkCallback;

    const resultCode =
      callback.ResultCode;

    const checkoutId =
      callback.CheckoutRequestID;

    console.log(
      `CALLBACK: ${checkoutId} | CODE ${resultCode}`
    );

    if (resultCode === 0) {

      const items =
        callback.CallbackMetadata.Item;

      let amount = '';
      let receipt = '';
      let phone = '';

      items.forEach(item => {

        if (item.Name === 'Amount') {
          amount = item.Value;
        }

        if (item.Name === 'MpesaReceiptNumber') {
          receipt = item.Value;
        }

        if (item.Name === 'PhoneNumber') {
          phone = item.Value;
        }
      });

      const tx =
        pendingTransactions[checkoutId];

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
        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('transactions')
        .add(transactionData);

      await sendReceiptSMS(
        phone,
        amount,
        receipt,
        tx?.plate || 'Revenue Payment'
      );

      console.log(
        `PAYMENT SUCCESS | ${receipt}`
      );

      delete pendingTransactions[checkoutId];
    }

    return res.json({
      success: true
    });

  } catch (error) {

    console.log(
      'CALLBACK ERROR:',
      error.message
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================= CASH PAYMENT =================

app.post('/api/cash', requireAuth, async (req, res) => {

  try {

    const {
      amount,
      plate,
      ward,
      revenueType
    } = req.body;

    const receipt =
      'CASH-' + Date.now();

    await db.collection('transactions')
      .add({
        amount,
        plate,
        ward,
        revenueType,
        paymentMethod: 'CASH',
        receipt,
        createdBy: req.session.user.username,
        status: 'PAID',
        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

    return res.json({
      success: true,
      receipt
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================= TRANSACTIONS =================

app.get('/api/transactions', requireAuth, async (req, res) => {

  try {

    const snapshot =
      await db.collection('transactions')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const transactions = [];

    snapshot.forEach(doc => {

      transactions.push({
        id: doc.id,
        ...doc.data()
      });
    });

    return res.json(transactions);

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================= ADMIN STATS =================

app.get('/api/admin/stats', requireAdmin, async (req, res) => {

  try {

    const snapshot =
      await db.collection('transactions').get();

    let totalRevenue = 0;

    snapshot.forEach(doc => {
      totalRevenue += Number(doc.data().amount || 0);
    });

    return res.json({
      success: true,
      totalTransactions: snapshot.size,
      totalRevenue
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================= START =================

app.listen(PORT, () => {

  console.log(
    `Bungoma Pay v1.9.0 running on port ${PORT}`
  );

  console.log(
    `Callback URL: ${CALLBACK_URL}`
  );
});
