const path = require("path");
const express = require('express')
const admin = require('firebase-admin')
const app = express()
app.use(express.json())
app.use(express.static("."));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static('public'))


const serviceAccount = require('./firebase-key.json')
admin.initializeApp({credential: admin.credential.cert(serviceAccount)})
const db = admin.firestore()
const payments = db.collection('payments')


app.post('/api/stkpush', async (req, res) => {
  const {phone, amount, service, plate, zone} = req.body;
  
  if (!phone || !amount) {
    return res.json({success: false, error: 'Phone and amount required'});
  }
  
  if (service === 'Parking' && !plate) {
    return res.json({success: false, error: 'Plate number required for parking'});
  }
  
  const receipt = 'BP' + Date.now();
  const amt = parseInt(amount);
  
  try {
    // 1. Save the actual transaction
    await db.collection('payments').add({
      phone: phone,
      amount: amt,
      service: service,
      plate: plate || '',
      zone: zone || '',
      ref: receipt,
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // 2. Update the running totals
    const statsRef = db.collection('stats').doc('totals');
    await statsRef.set({
      totalCollected: admin.firestore.FieldValue.increment(amt),
      transactionCount: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    
    console.log(`v1_4 Payment SAVED: ${phone} - KES${amt} - ${service} - ${plate}`);
    res.json({success: true, receipt: receipt});
    
  } catch (err) {
    console.error('Firestore save error:', err);
    res.json({success: false, error: 'Failed to save transaction'});
  }
});
app.listen(3000, () => console.log('Bungoma Pay v1.4 Firebase running'))


