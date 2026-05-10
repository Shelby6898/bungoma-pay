require('dotenv').config();
// Bungoma Pay v1.6.2 - Cash + STK Push + BARMS-proof
// Author: Shelby | Date: May 9, 2026

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const moment = require('moment');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
const path = require('path');
app.use(express.static('.'));
app.get('/', (req, res) => {
  res.json({status: "Bungoma Pay v1_6_2 online", time: new Date()});
});

// === FIREBASE SETUP ===
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// === DARAJA CONFIG ===
// TODO: Replace with your real Daraja credentials for production
const MPESA_CONSUMER_KEY = process.env.CONSUMER_KEY
const MPESA_CONSUMER_SECRET = process.env.CONSUMER_SECRET
const MPESA_PASSKEY = process.env.PASSKEY
const MPESA_SHORTCODE = process.env.SHORTCODE
const MPESA_ENV = "sandbox"
const CALLBACK_URL = process.env.CALLBACK_URL
const MPESA_BASE_URL = MPESA_ENV === 'sandbox' 
 ? 'https://sandbox.safaricom.co.ke' 
  : 'https://api.safaricom.co.ke';

// === UTILS ===
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

function formatPhone(phone) {
  // Convert 07XX or +2547XX or 7XX to 2547XX
  let cleaned = phone.replace(/\s+/g, '').replace(/^\+/, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1);
  if (cleaned.startsWith('7')) cleaned = '254' + cleaned;
  return cleaned;
}

// === ROUTES ===

// Health check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({status: "Bungoma Pay v1_6_2 online", time: new Date()});
});
// v1.6.1: CASH PAYMENT - Idempotent save. Kills duplicate revenue bug.
app.post('/api/pay', async (req, res) => {
  try {
    const data = req.body;
    
    // FORCE CLIENT_ID - BARMS DEFENSE LAYER 1
    if(!data.client_id) {
      data.client_id = `pending_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
      console.log(`v1.6.2 GENERATED client_id: ${data.client_id}`);
    }
    
    // DEDUPE CHECK - BARMS DEFENSE LAYER 2
    const existing = await db.collection('payments')
     .where('client_id', '==', data.client_id)
     .limit(1)
     .get();
    
    if(!existing.empty) {
      console.log(`v1.6.2 CASH DUPLICATE BLOCKED: ${data.plate} - ${data.client_id}`);
      return res.json({success: true, duplicate: true, message: 'Already synced'});
    }
    
    const finalData = {
     ...data,
      mode: 'cash',
      status: 'PAID',
      synced_at: admin.firestore.FieldValue.serverTimestamp(),
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('payments').add(finalData);
    
    // Update stats only for PAID cash
    await db.collection('stats').doc('totals').set({
      totalCollected: admin.firestore.FieldValue.increment(data.amount),
      transactionCount: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    
    console.log(`v1.6.2 CASH SYNCED: ${data.plate} - KES${data.amount}`);
    res.json({success: true, id: docRef.id});
    
  } catch(err) {
    console.error(`v1.6.2 cash sync error:`, err);
    res.status(500).json({success: false, error: err.message});
  }
});

// v1.6.2: STK PUSH - Trigger M-Pesa payment
app.post('/api/stkpush', async (req, res) => {
  try {
    const { amount, phone, plate, zone, client_id } = req.body;
    
    if(!amount ||!phone ||!client_id) {
      return res.status(400).json({success: false, error: 'amount, phone, client_id required'});
    }
    
    const formattedPhone = formatPhone(phone);
    if(!/^2547\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({success: false, error: 'Invalid phone format. Use 07XXXXXXXX'});
    }
    
    // DEDUPE CHECK - Don't STK twice for same client_id
    const existing = await db.collection('payments').where('client_id', '==', client_id).limit(1).get();
    if(!existing.empty) {
      console.log(`v1.6.2 STK DUPLICATE BLOCKED: ${plate} - ${client_id}`);
      return res.json({success: true, duplicate: true, message: 'STK already sent'});
    }
    
    const token = await getMpesaToken();
    const timestamp = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString('base64');
    
    const stkData = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline", // Use "CustomerBuyGoodsOnline" for Till
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: plate || "BungomaPay",
      TransactionDesc: `Parking ${zone || 'Zone'} - ${plate || ''}`
    };
    
    const stkRes = await axios.post(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, stkData, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    // Save as PENDING - Only count stats when PAID via callback
    await db.collection('payments').add({
      client_id,
      plate: plate || null,
      zone: zone || null,
      amount: Number(amount),
      phone: formattedPhone,
      mode: 'stk',
      status: 'PENDING',
      CheckoutRequestID: stkRes.data.CheckoutRequestID,
      MerchantRequestID: stkRes.data.MerchantRequestID,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`v1.6.2 STK SENT: ${plate} - KES${amount} - ${stkRes.data.CheckoutRequestID}`);
    res.json({
      success: true, 
      CheckoutRequestID: stkRes.data.CheckoutRequestID,
      CustomerMessage: stkRes.data.CustomerMessage
    });
    
  } catch(err) {
    console.error('STK error:', err.response?.data || err.message);
    res.status(500).json({success: false, error: err.response?.data?.errorMessage || 'STK failed'});
  }
});

// v1.6.2: CALLBACK - Safaricom hits this after STK
app.post('/api/callback', async (req, res) => {
  try {
    const callback = req.body.Body.stkCallback;
    const checkoutId = callback.CheckoutRequestID;
    console.log(`v1.6.2 CALLBACK: ${checkoutId} - Code ${callback.ResultCode}`);
    
    const q = await db.collection('payments').where('CheckoutRequestID', '==', checkoutId).limit(1).get();
    if(q.empty) {
      console.log(`v1.6.2 CALLBACK ORPHAN: No payment found for ${checkoutId}`);
      return res.json({ResultCode: 0, ResultDesc: "Accepted"});
    }
    
    const doc = q.docs[0];
    
    if(callback.ResultCode === 0) {
      // SUCCESS
      const meta = callback.CallbackMetadata.Item;
      const amount = meta.find(i => i.Name === 'Amount').Value;
      const mpesaCode = meta.find(i => i.Name === 'MpesaReceiptNumber').Value;
      const phone = meta.find(i => i.Name === 'PhoneNumber').Value;
      const transDate = meta.find(i => i.Name === 'TransactionDate').Value;
      
      await doc.ref.update({
        status: 'PAID',
        mpesaCode,
        paid_at: admin.firestore.FieldValue.serverTimestamp(),
        mpesa_trans_date: transDate,
        mpesa_phone: phone
      });
      
      // Update stats ONLY on successful payment
      await db.collection('stats').doc('totals').set({
        totalCollected: admin.firestore.FieldValue.increment(amount),
        transactionCount: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
      
      console.log(`v1.6.2 STK PAID: ${doc.data().plate} - ${mpesaCode} - KES${amount}`);
    } else {
      // FAILED, CANCELLED, TIMEOUT
      await doc.ref.update({
        status: 'FAILED',
        resultCode: callback.ResultCode,
        resultDesc: callback.ResultDesc,
        failed_at: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`v1.6.2 STK FAILED: ${doc.data().plate} - ${callback.ResultDesc}`);
    }
    
    res.json({ResultCode: 0, ResultDesc: "Accepted"});
  } catch(err) {
    console.error('Callback error:', err);
    res.json({ResultCode: 0, ResultDesc: "Accepted"}); // Always ACK to stop Safaricom retries
  }
});

// Stats endpoint for dashboard
app.get('/api/stats', async (req, res) => {
  try {
    const statsDoc = await db.collection('stats').doc('totals').get();
    const stats = statsDoc.exists? statsDoc.data() : { totalCollected: 0, transactionCount: 0 };
    res.json({success: true,...stats});
  } catch(err) {
    res.status(500).json({success: false});
  }
});

// === START SERVER ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bungoma Pay v1.6.2 running on port ${PORT}`);
  console.log(`MPESA_ENV: ${MPESA_ENV} | Shortcode: ${MPESA_SHORTCODE}`);
  console.log(`Callback URL: ${CALLBACK_URL}`);
});


