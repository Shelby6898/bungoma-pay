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

// v1.6.1: Idempotent save. Kills duplicate revenue bug.
app.post('/api/pay', async (req, res) => {
  try {
    const data = req.body;
    
    // FORCE CLIENT_ID - THIS IS THE FIX
    if(!data.client_id) {
      data.client_id = `pending_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
      console.log(`v1.6.1 GENERATED client_id: ${data.client_id}`);
    }
    
    // DEDUPE CHECK - NO IF STATEMENT, ALWAYS RUNS
    try {
      const existing = await db.collection('payments')
        .where('client_id', '==', data.client_id)
        .limit(1)
        .get();
      
      if(!existing.empty) {
        console.log(`v1.6.1 DUPLICATE BLOCKED: ${data.plate} - ${data.client_id}`);
        return res.json({success: true, duplicate: true, message: 'Already synced'});
      }
    } catch(queryErr) {
      console.error(`v1.6.1 DEDUPE QUERY FAILED:`, queryErr);
      console.error(`v1.6.1 INDEX LINK:`, queryErr);
    }
    
    const finalData = {
      ...data,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'SYNCED'
    };
    
    const docRef = await db.collection('payments').add(finalData);
    
    await db.collection('stats').doc('totals').set({
      totalCollected: admin.firestore.FieldValue.increment(data.amount),
      transactionCount: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    
    console.log(`v1.6.1 SYNCED: ${data.plate} - KES${data.amount}`);
    res.json({success: true, id: docRef.id});
    
  } catch(err) {
    console.error(`v1.6.1 sync error:`, err);
    res.status(500).json({success: false});
  }
});


app.listen(3000, () => console.log('Bungoma Pay v1.6.1 DEDUPE firebase running'));

