require('dotenv').config({ path: '/data/data/com.termux/files/home/bungoma-pay/.env' });
const express        = require('express');
const axios          = require('axios');
const cors           = require('cors');
const moment         = require('moment');
const AfricasTalking = require('africastalking');
const admin          = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
// ============== FIREBASE ==============
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db   = admin.firestore();
const auth = admin.auth();

// ============== AFRICA'S TALKING ==============
let at;
try {
  at = AfricasTalking({
    apiKey:   process.env.AT_API_KEY || 'sandbox',
    username: process.env.AT_USERNAME || 'sandbox'
  });
} catch(e) {
  console.log('AT init skipped:', e.message);
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

// ============== HELPERS ==============
async function getMpesaToken() {
  const b64 = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const r   = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${b64}` } }
  );
  return r.data.access_token;
}



async function sendReceiptSMS(phone, amount, receipt, plate) {
  if (!at) return; // skip if AT not initialized

  let p = String(phone);
  if (p.startsWith('254')) p = '+' + p;
  if (p.startsWith('0'))   p = '+254' + p.slice(1);
  const msg = `Bungoma County Revenue: KES ${amount} received for ${plate}. Receipt: ${receipt}. Thank you!`;
  try {
    await at.SMS.send({ to: [p], message: msg });
  } catch (e) {
    console.log('SMS ERROR=', e.message);
  }
}
async function getOfficerData(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? doc.data() : {};
}

// ============== ROUTES ==============

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});
// Current user info
app.get('/api/me', verifyToken, async (req, res) => {
  const doc = await db.collection('users').doc(req.user.uid).get();
  res.json({ success: true, user: { uid: req.user.uid, email: req.user.email, ...doc.data() } });
});

// Heartbeat — officer presence
app.post('/api/heartbeat', verifyToken, async (req, res) => {
  await db.collection('users').doc(req.user.uid).update({
    status: 'online', lastSeen: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
  res.json({ success: true });
});

// Mark offline
app.post('/api/offline', verifyToken, async (req, res) => {
  await db.collection('users').doc(req.user.uid).update({
    status: 'offline', lastSeen: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
  res.json({ success: true });
});

// ── STK Push ──────────────────────────────────────────────
app.post('/api/pay', verifyToken, async (req, res) => {
  try {
    const { phone, amount, plate, ward, revenueType } = req.body;
    if (!phone || !amount || !plate) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const dedupKey = `${req.user.uid}:${phone}:${amount}:${plate}`;
    if (isDuplicate(dedupKey)) {
      return res.status(409).json({
        success: false,
        message: 'Duplicate payment detected. Please wait 60 seconds before retrying.'
      });
    }

    let fp = String(phone);
    if (fp.startsWith('0'))  fp = '254' + fp.substring(1);
    if (fp.startsWith('+'))  fp = fp.substring(1);

    const token     = await getMpesaToken();
    const ts        = moment().format('YYYYMMDDHHmmss');
    const password  = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${ts}`).toString('base64');

    const stkRes = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         ts,
        TransactionType:   'CustomerPayBillOnline',
        Amount:            amount,
        PartyA:            fp,
        PartyB:            MPESA_SHORTCODE,
        PhoneNumber:       fp,
        CallBackURL:       CALLBACK_URL,
        AccountReference:  plate,
        TransactionDesc:   revenueType || 'Revenue Payment'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutId  = stkRes.data.CheckoutRequestID;
    const officerData = await getOfficerData(req.user.uid);

    pendingTransactions[checkoutId] = {
      plate, amount, phone: fp, ward, revenueType,
      createdBy:       req.user.uid,
      officerUsername: officerData.username || officerData.name || req.user.email,
      createdAt:       new Date()
    };

markRequest(dedupKey);
    console.log(`\n=== STK SENT === Plate:${plate} | KES${amount} | Phone:${fp}\n`);
    res.json({ success: true, message: 'STK Push Sent', checkoutId });
  } catch (error) {
    console.log('STK ERROR=', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── M-Pesa Callback ───────────────────────────────────────
app.post('/api/callback', async (req, res) => {
  try {
    const callback   = req.body.Body.stkCallback;
    const resultCode = callback.ResultCode;
    const checkoutId = callback.CheckoutRequestID;
console.log(`\n=== CALLBACK RECEIVED === ID:${checkoutId} | Code:${resultCode}\n`);

    if (resultCode === 0) {
      const items = callback.CallbackMetadata?.Item || [];
      let amount = '', receipt = '', phone = '';
      items.forEach(i => {
        if (i.Name === 'Amount')             amount  = i.Value;
        if (i.Name === 'MpesaReceiptNumber') receipt = i.Value;
        if (i.Name === 'PhoneNumber')        phone   = i.Value;
      });

      const tx = pendingTransactions[checkoutId];
      await db.collection('transactions').add({
        amount, receipt, phone,
        plate:           tx?.plate           || '',
        ward:            tx?.ward            || '',
        revenueType:     tx?.revenueType     || '',
        paymentMethod:   'M-PESA',
        createdBy:       tx?.createdBy       || '',
        officerUsername: tx?.officerUsername || '',
        status:          'PAID',
        createdAt:       admin.firestore.FieldValue.serverTimestamp()
      });

      await sendReceiptSMS(phone, amount, receipt, tx?.plate || 'Revenue Payment');
console.log(`\n=== PAYMENT SUCCESS === Receipt:${receipt} | KES${amount}\n`);      
delete pendingTransactions[checkoutId];
    }

    res.json({ success: true });
  } catch (error) {
    console.log('CALLBACK ERROR=', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Cash Payment ──────────────────────────────────────────
app.post('/api/cash', verifyToken, async (req, res) => {
  try {
    const { amount, plate, ward, revenueType } = req.body;
    const officerData = await getOfficerData(req.user.uid);
    const receipt     = 'CASH-' + Date.now();

    await db.collection('transactions').add({
      amount, plate,
      ward:            ward || officerData.ward || '',
      revenueType,
      paymentMethod:   'CASH',
      receipt,
      createdBy:       req.user.uid,
      officerUsername: officerData.username || officerData.name || req.user.email,
      status:          'PAID',
      createdAt:       admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, receipt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Admin Stats ────────────────────────────────────────────
app.get('/api/admin/stats', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('transactions').get();
    let totalRevenue = 0, mpesaTotal = 0, cashTotal = 0;

    snapshot.forEach(doc => {
      const d = doc.data();
      const a = Number(d.amount) || 0;
      totalRevenue += a;
      if (d.paymentMethod === 'M-PESA') mpesaTotal += a; else cashTotal += a;
    });

    res.json({ success: true, totalTransactions: snapshot.size, totalRevenue, mpesaTotal, cashTotal });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Create Officer ─────────────────────────────────────────
app.post('/api/create-officer', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { username, email, password, ward, role } = req.body;
    if (!username || !email || !password || !ward) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }

    const userRecord = await auth.createUser({ email, password, displayName: username });

    await db.collection('users').doc(userRecord.uid).set({
      username, email, ward,
      role:     role || 'officer',
      status:   'offline',
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      createdAt:admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, uid: userRecord.uid, message: `Officer ${username} created` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── List Officers ──────────────────────────────────────────
app.get('/api/officers', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users').where('role', '==', 'officer').get();
    const officers = [];
    snapshot.forEach(doc => officers.push({ uid: doc.id, ...doc.data() }));
    res.json({ success: true, officers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Generate Report ────────────────────────────────────────
app.post('/api/report', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { type, startDate, endDate, ward, officerUid } = req.body;
    let query = db.collection('transactions');

    if (type === 'daily') {
      const s = admin.firestore.Timestamp.fromDate(moment(startDate).startOf('day').toDate());
      const e = admin.firestore.Timestamp.fromDate(moment(startDate).endOf('day').toDate());
      query = query.where('createdAt', '>=', s).where('createdAt', '<=', e);
    } else if (type === 'weekly' || type === 'monthly') {
      const s = admin.firestore.Timestamp.fromDate(moment(startDate).startOf('day').toDate());
      const e = admin.firestore.Timestamp.fromDate(moment(endDate).endOf('day').toDate());
      query = query.where('createdAt', '>=', s).where('createdAt', '<=', e);
    } else if (type === 'ward') {
      query = query.where('ward', '==', ward);
    } else if (type === 'officer') {
      query = query.where('createdBy', '==', officerUid);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();
    const transactions = [];
    let totalRevenue = 0, mpesaTotal = 0, cashTotal = 0;

    snapshot.forEach(doc => {
      const d = doc.data();
      transactions.push({ id: doc.id, ...d });
      const a = Number(d.amount) || 0;
      totalRevenue += a;
      if (d.paymentMethod === 'M-PESA') mpesaTotal += a; else cashTotal += a;
    });

    res.json({
      success: true,
      summary: { type, totalTransactions: transactions.length, totalRevenue, mpesaTotal, cashTotal, generatedAt: new Date().toISOString() },
      transactions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Broadcast ──────────────────────────────────────────────
app.post('/api/broadcast', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });

    const senderData = await getOfficerData(req.user.uid);
    await db.collection('broadcasts').add({
      message,
      senderName: senderData.username || 'Admin',
      senderUid:  req.user.uid,
      readBy:     [],
      createdAt:  admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Broadcast sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark broadcast read
app.post('/api/broadcast/:id/read', verifyToken, async (req, res) => {
  try {
    await db.collection('broadcasts').doc(req.params.id).update({
      readBy: admin.firestore.FieldValue.arrayUnion(req.user.uid)
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Update Profile ─────────────────────────────────────────
app.post('/api/profile/update', verifyToken, async (req, res) => {
  try {
    const { username, ward } = req.body;
    const updates = {};
    if (username) updates.username = username;
    if (ward)     updates.ward     = ward;

    await db.collection('users').doc(req.user.uid).update(updates);
    if (username) await auth.updateUser(req.user.uid, { displayName: username });

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Sync Offline Transactions ─────────────────────────────
app.post('/api/sync-offline', verifyToken, async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!Array.isArray(transactions) || !transactions.length) {
      return res.json({ success: true, synced: 0 });
    }

    const officerData = await getOfficerData(req.user.uid);
    let synced = 0;
    const batch = db.batch();

    for (const tx of transactions) {
      // Deduplicate by offline receipt
      const exists = await db.collection('transactions').where('receipt', '==', tx.receipt).limit(1).get();
      if (!exists.empty) continue;

      const ref = db.collection('transactions').doc();
      batch.set(ref, {
        amount:          tx.amount,
        plate:           tx.plate        || '',
        ward:            tx.ward         || officerData.ward || '',
        revenueType:     tx.revenueType  || '',
        paymentMethod:   'CASH',
        receipt:         tx.receipt,
        createdBy:       req.user.uid,
        officerUsername: officerData.username || req.user.email,
        status:          'PAID',
        offlineSync:     true,
        createdAt:       admin.firestore.FieldValue.serverTimestamp()
      });
      synced++;
    }

    await batch.commit();
    res.json({ success: true, synced });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============== START ==============
app.listen(PORT, () => {
  console.log(`Bungoma Pay v3.0 running on port ${PORT}`);
  console.log(`Callback URL= ${CALLBACK_URL}`);
});
