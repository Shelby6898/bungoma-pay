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

app.post('/api/pay', async (req,res) => {
  const {amount, phone, service} = req.body
  const ref = 'BP'+Date.now()
  const ts = new Date().toISOString()
  await payments.doc(ref).set({ref, amount: Number(amount), service, phone, ts})
  res.json({success:true, ref, amount})
})

app.get('/api/health', async (req,res) => {
  const snap = await payments.get()
  let total = 0, count = 0
  snap.forEach(doc => { total += doc.data().amount; count++ })
  res.json({status:'OK', total, count})
})

app.get("/stats", async (req, res) => { const snapshot = await db.collection("payments").get(); const total = snapshot.docs.reduce((sum, doc) => sum + doc.data().amount, 0); res.json({ total, count: snapshot.size }); });
app.listen(3000, () => console.log('Bungoma Pay v1.3 Firebase running'))
