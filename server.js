const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;
const DB = path.join(__dirname, 'db', 'revenue.json');
app.use(express.static('public'));
app.use(express.json());
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type'); next(); });
const readDB = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const writeDB = (data) => fs.writeFileSync(DB, JSON.stringify(data, null, 2));
if (!fs.existsSync('db')) fs.mkdirSync('db');
if (!fs.existsSync(DB)) writeDB({payments: []});
app.get('/api/health', (req, res) => {
  const db = readDB()
  const payments = Array.isArray(db) ? db : db.payments || []
  const total = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
  res.json({ status: 'OK', total: total, count: payments.length })
})

app.post('/api/pay', (req, res) => {
  const { amount, phone, service } = req.body
  const db = readDB()
  const payments = Array.isArray(db) ? db : db.payments || []
  
  const payment = {
    id: `BP${Date.now()}`,
    amount: Number(amount) || 0,  // <-- Fixes undefined
    phone: phone || 'N/A',
    service: service || 'General',
    time: new Date().toISOString(),
    synced: false
  }
  
  payments.push(payment)
  
  if (Array.isArray(db)) {
    writeDB(payments)
  } else {
    db.payments = payments
    db.total = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
    writeDB(db)
  }
  
  res.json({ success: true, ref: payment.id, amount: payment.amount })  // <-- Returns amount
})
app.listen(PORT, () => console.log(`Bungoma Pay running on port ${PORT}`));
