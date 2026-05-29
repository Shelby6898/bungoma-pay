# 💳 Bungoma Pay — Digital Revenue Collection Platform

> **Live System:** https://pay.icthelpdesk.site
> **Version:** 3.0 | **Status:** Production Ready | **County:** Bungoma County Government

---

## 📋 Overview

Bungoma Pay is a mobile-first, real-time digital revenue collection and management platform built for Bungoma County Government. It replaces manual cash-based revenue collection with a secure, transparent, and accountable digital system integrated with M-PESA (Safaricom Daraja API) and Firebase.

Field revenue officers collect payments directly from taxpayers using M-PESA STK Push or cash, while administrators monitor all collections in real time from a centralized dashboard by officer, ward, revenue type, and date.

---

## 🚀 Live URLs

- Login: https://pay.icthelpdesk.site
- Officer Dashboard: https://pay.icthelpdesk.site/index.html
- Admin Dashboard: https://pay.icthelpdesk.site/admin.html
- M-PESA Callback: https://pay.icthelpdesk.site/api/callback

---

## ✨ Features

### 👤 Officer Portal
- M-PESA STK Push — Initiate payment prompts to taxpayer phone
- Cash Recording — Record and receipt cash payments instantly
- Camera OCR — Scan vehicle plates using phone camera (Tesseract.js)
- Offline Mode — Save payments locally, auto-sync when reconnected
- Real-time Transactions — Personal feed updating live via Firebase
- Broadcast Alerts — Receive real-time messages from admin

### 🛡️ Admin Dashboard
- Live Statistics — Total revenue, M-PESA vs cash, transaction count
- Officer Management — All officers, wards, amounts, online/offline status
- Add Officer — Create accounts from dashboard (Firebase Auth + Firestore)
- Reports — Daily, Weekly, Monthly, By Ward, By Officer with CSV export
- Broadcast Messaging — Real-time messages to all field officers
- Settings — Update admin profile and ward assignments

### 🔒 Security
- Firebase Authentication (email/password)
- Role-based access control — officers see only their own data
- Firestore Security Rules — field-level data isolation
- JWT token verification on every API endpoint
- Payment idempotency — prevents duplicate STK charges (60-second window)
- HTTPS via Cloudflare Tunnel with TLS termination

---

## 🏗️ Tech Stack

- Frontend: HTML5, CSS3, Vanilla JavaScript
- Backend: Node.js + Express.js
- Database: Firebase Firestore (Real-time)
- Authentication: Firebase Authentication
- Payments: Safaricom Daraja API (M-PESA STK Push)
- SMS: Africa's Talking API
- Process Manager: PM2
- Tunnel: Cloudflare Named Tunnel
- Domain: pay.icthelpdesk.site

---

## 📁 Project Structure
---

## ⚙️ Environment Variables

```env
CONSUMER_KEY=your_mpesa_consumer_key
CONSUMER_SECRET=your_mpesa_consumer_secret
PASSKEY=your_mpesa_passkey
SHORTCODE=your_mpesa_shortcode
CALLBACK_URL=https://pay.icthelpdesk.site/api/callback
AT_API_KEY=your_africastalking_api_key
AT_USERNAME=your_africastalking_username
PORT=3000
```

---

## 🔌 API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | / | None | Serves login page |
| GET | /api/me | User | Get current user profile |
| POST | /api/pay | User | Initiate M-PESA STK Push |
| POST | /api/callback | None | M-PESA payment callback |
| POST | /api/cash | User | Record cash payment |
| GET | /api/transactions | User | Get transactions (role-scoped) |
| GET | /api/admin/stats | Admin | Revenue statistics |
| POST | /api/create-officer | Admin | Create officer account |
| GET | /api/officers | Admin | List all officers |
| POST | /api/report | Admin | Generate revenue report |
| POST | /api/broadcast | Admin | Send broadcast to officers |
| POST | /api/broadcast/:id/read | User | Mark broadcast as read |
| POST | /api/profile/update | User | Update profile |
| POST | /api/sync-offline | User | Sync offline transactions |
| POST | /api/heartbeat | User | Update officer online status |

---

## 🗄️ Firestore Data Model

### users/{uid}
```json
{
  "username": "John Wanjiru",
  "email": "john@bungoma.go.ke",
  "ward": "Kanduyi",
  "role": "officer",
  "status": "online",
  "lastSeen": "Timestamp"
}
```

### transactions/{txId}
```json
{
  "amount": 200,
  "plate": "KCA 123A",
  "ward": "Kanduyi",
  "revenueType": "Parking",
  "paymentMethod": "M-PESA",
  "receipt": "RGH7YK123",
  "createdBy": "officerUID",
  "officerUsername": "John Wanjiru",
  "status": "PAID",
  "createdAt": "Timestamp"
}
```

### broadcasts/{bcId}
```json
{
  "message": "All officers report by 5PM",
  "senderName": "Admin",
  "readBy": ["uid1", "uid2"],
  "createdAt": "Timestamp"
}
```

---

## 🗺️ Firestore Indexes Required

| Collection | Fields | Purpose |
|-----------|--------|---------|
| transactions | createdBy ASC, createdAt DESC | Officer transaction feed |
| transactions | ward ASC, createdAt ASC | Ward reports |
| transactions | createdBy ASC, createdAt ASC | Officer date range reports |
| transactions | receipt ASC, createdAt DESC | Offline sync deduplication |
| users | role ASC, createdAt DESC | Officer list queries |

---

## 🛠️ Installation

```bash
# 1. Clone the repository
git clone https://github.com/Shelby6898/bungoma-pay.git
cd bungoma-pay

# 2. Install dependencies
npm install express axios cors moment africastalking firebase-admin dotenv

# 3. Add Firebase service account
# Download firebase-key.json from Firebase Console
# Place in root directory

# 4. Create .env file
cp .env.example .env

# 5. Start server
node server.js

# 6. Production with PM2
npm install -g pm2
pm2 start server.js --name bungoma-pay
pm2 save
```

---

## 📊 PM2 Commands

```bash
pm2 list                              # View all processes
pm2 logs bungoma-pay                  # Live logs
pm2 restart bungoma-pay --update-env  # Restart after .env changes
pm2 stop bungoma-pay                  # Stop server
pm2 flush bungoma-pay                 # Clear logs
```

---

## 🗺️ Supported Wards

Kanduyi | Kimilili | Webuye East | Webuye West | Tongaren | Sirisia | Mt. Elgon | Bumula | Township

---

## 📈 Roadmap

- [x] M-PESA STK Push integration
- [x] Real-time admin dashboard
- [x] Officer presence tracking
- [x] Offline mode with auto-sync
- [x] Camera OCR plate scanning
- [x] Report generation with CSV export
- [x] Broadcast messaging
- [x] Permanent domain deployment
- [ ] Safaricom production credentials
- [ ] IFMIS integration
- [ ] Native Android app
- [ ] Automated daily email reports
- [ ] Taxpayer receipt verification portal

---

## 👨‍💻 Developer

**Elphas Shelby**
🎓 Kaimosi Friends University
📧 elphazshelby@gmail.com
🌐 https://pay.icthelpdesk.site
💻 https://github.com/Shelby6898

---

## 🏛️ Client

**Bungoma County Government**
Department of Finance & Revenue Management
Bungoma County, Kenya

---

## 📄 License

This project is proprietary software developed exclusively for Bungoma County Government.
© 2026 Elphas Shelby — All rights reserved.

---

💳 Bungoma Pay v3.0 — Transforming Revenue Collection for Bungoma County
Built with ❤️ by Elphas Shelby
