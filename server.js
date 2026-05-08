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
app.post("/pay", (req, res) => {
  // Forward to /api/pay handler
  req.url = "/api/pay"; 
  app(req, res);
});
app.post("/pay", async (req,res) => {
  const {amount, phone, service, plate, zone} = req.body
  
  // LOOPHOLE FIX 1: Reject if plate missing for Parking
  if(service === "Parking" && !plate){
    return res.status(400).json({success:false, error:"Plate number required for parking"})
  }
  
  // LOOPHOLE FIX 2: Server-generated ref, not user input
  const ref = "BP" + Date.now()
  const ts = new Date().toISOString()
  
  // LOOPHOLE FIX 3: Save GPS + device fingerprint later
  const record = {
    ref, 
    amount: Number(amount), 
    phone, 
    service, 
    plate: plate?.toUpperCase(), // Force KDP455H format
    zone: zone || "Bungoma Town",
    ts,
    status: "PENDING_MPESA", // BARMS doesn't track this
    collector: "SHELBY_WEB_v1_4" // Replace with login later
  }
  
  await payments.doc(ref).set(record)
  
  // TODO: Real Daraja STK Push here. For demo, auto-confirm:
  await payments.doc(ref).update({status: "CONFIRMED", mpesa_code: "TEST"+ref})
  
  res.json({success:true, ref, amount, message:"STK sent. Auto-confirmed for demo."})
});

app.get("/verify/:ref", async (req,res) => {
  const doc = await payments.doc(req.params.ref).get()
  if(!doc.exists) return res.status(404).json({valid:false})
  
  const data = doc.data()
  // LOOPHOLE FIX 4: Only CONFIRMED payments are valid
  res.json({
    valid: data.status === "CONFIRMED",
    ref: data.ref,
    plate: data.plate,
    amount: data.amount,
    ts: data.ts,
    mpesa_code: data.mpesa_code
  })
});

app.get('/api/health', async (req,res) => {
  const snap = await payments.get()
  let total = 0, count = 0
  snap.forEach(doc => { total += doc.data().amount; count++ })
  res.json({status:'OK', total, count})
})

app.get("/stats", async (req, res) => { const snapshot = await db.collection("payments").get(); const total = snapshot.docs.reduce((sum, doc) => sum + doc.data().amount, 0); res.json({ total, count: snapshot.size }); });
app.listen(3000, () => console.log('Bungoma Pay v1.3 Firebase running'))
