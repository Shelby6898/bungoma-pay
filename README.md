# 💳 Bungoma Pay — Digital Revenue Collection Platform

> **Live System:** https://bungoma-pay.onrender.com
> **Version:** 3.0 | **Status:** Active Development | **County:** Bungoma County

---

## 📋 Overview

Bungoma Pay is a mobile-first, real-time digital revenue collection and management platform built for Bungoma County Government. It replaces manual cash-based revenue collection with a secure, transparent, and accountable digital system integrated with M-PESA (Safaricom Daraja API) and Firebase.

Field revenue officers collect payments directly from taxpayers using M-PESA STK Push or cash, while administrators monitor all collections in real time from a centralized dashboard by officer, ward, revenue type, and date.

---

## 🚀 Live URLs

- Main Application: https://bungoma-pay.onrender.com
- Officer Portal: https://bungoma-pay.onrender.com/officer/
- Administrator Portal: https://bungoma-pay.onrender.com/admin/
- M-PESA Callback: https://bungoma-pay.onrender.com/api/callback

The root URL redirects to the officer portal. Both portals use the shared React frontend.

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
- Firebase ID token verification on authenticated API endpoints
- Payment idempotency — prevents duplicate STK charges (60-second window)
- HTTPS provided by Render with managed TLS termination

---

## 🏗️ Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, Vite 8 |
| Routing | React Router 7 |
| UI and icons | CSS3, Lucide React |
| Frontend Firebase SDK | Firebase JavaScript SDK |
| Backend runtime | Node.js |
| Backend framework | Express 5 |
| Backend Firebase SDK | Firebase Admin SDK 14 |
| Database | Cloud Firestore |
| Authentication | Firebase Authentication |
| Payments | Safaricom Daraja API (M-PESA) |
| SMS | Africa's Talking |
| HTTP client | Axios |
| Security | Helmet, Express Rate Limit, bcryptjs |
| Testing | Node.js built-in test runner |
| Code quality | ESLint |
| Deployment | Render |
| Version control | Git and GitHub |

### Programming Languages

- **JavaScript** — primary language; CommonJS on the backend and ES modules on the frontend
- **CSS3** — interface styling
- **HTML5** — frontend document structure
- **JSON** — configuration and data exchange

## 📁 Project Structure

```text
bungoma-pay/
├── client/
│   ├── src/
│   │   ├── assets/
│   │   ├── App.jsx
│   │   ├── AuthGate.jsx
│   │   ├── OfficerPortal.jsx
│   │   ├── firebase.js
│   │   ├── firestore.js
│   │   ├── App.css
│   │   ├── AuthGate.css
│   │   ├── OfficerPortal.css
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── public/
│   ├── login.html
│   ├── admin.html
│   └── index.html
├── scripts/
├── test/
├── server.js
├── mpesa-callback-processor.js
├── mpesa-callback-recovery.js
├── mpesa-payment-intents.js
├── mpesa-reconciliation-handler.js
├── mpesa-reconciliation-result.js
├── analytics-aggregates.js
├── admin-stats-handler.js
├── broadcast-response.js
├── location-data.js
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── package.json
└── README.md
```

The client/ directory contains the React application. The root-level Express server serves the built frontend and provides the backend API.

## ⚙️ Environment Variables

Configure backend variables in Render for production.
For local development, use a private `.env` file.

### Backend

```env
CONSUMER_KEY=your_mpesa_consumer_key
CONSUMER_SECRET=your_mpesa_consumer_secret
PASSKEY=your_mpesa_passkey
SHORTCODE=your_mpesa_shortcode
CALLBACK_URL=https://bungoma-pay.onrender.com/api/callback
AT_API_KEY=your_africastalking_api_key
AT_USERNAME=your_africastalking_username
FIREBASE_SERVICE_ACCOUNT=your_service_account_json
PORT=3000
```

Firebase Admin uses FIREBASE_SERVICE_ACCOUNT or a local
`firebase-key.json` service-account file. Never commit credentials.
Render provides the production service port.

### Frontend

Set these Vite variables when building the React application.
Use `client/.env` locally and deployment settings in production.

```env
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_APP_ID=your_firebase_app_id
VITE_FIREBASE_AUTH_DOMAIN=your_firebase_auth_domain
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_PROJECT_ID=your_firebase_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_firebase_storage_bucket
```

### Local Firebase Emulator (Optional)

```env
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

Use emulator settings only for local emulator testing.
Do not configure emulator hosts in production.

---
## 🔌 API Endpoints

The root URL redirects to `/officer/`. The React portals are served at
`/officer/` and `/admin/`.

| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/api/me` | Authenticated | Get current user profile |
| POST | `/api/heartbeat` | Authenticated | Update officer presence |
| POST | `/api/offline` | Authenticated | Update offline status |
| POST | `/api/pay` | Officer | Initiate M-PESA STK Push |
| POST | `/api/callback` | M-PESA callback | Receive payment result |
| POST | `/api/cash` | Officer | Record cash payment |
| GET | `/api/transactions` | Authenticated | Get role-scoped transactions |
| GET | `/api/admin/mpesa/pending` | Admin | List pending M-PESA payments |
| POST | `/api/admin/mpesa/reconcile` | Admin | Reconcile a pending payment |
| GET | `/api/admin/stats` | Admin | Retrieve dashboard statistics |
| GET | `/api/admin/revenue-trend` | Admin | Retrieve revenue trend |
| GET | `/api/locations` | Admin | List supported locations |
| POST | `/api/create-officer` | Admin | Create an officer account |
| GET | `/api/admin/officer-activity` | Admin | Retrieve officer activity |
| GET | `/api/officers` | Admin | List officers |
| PUT | `/api/officers/:uid/location` | Admin | Update officer location |
| POST | `/api/report` | Admin | Generate revenue report |
| POST | `/api/broadcast` | Admin | Send a broadcast |
| GET | `/api/broadcasts` | Officer | Retrieve broadcasts |
| POST | `/api/broadcast/:id/read` | Officer | Mark a broadcast as read |
| POST | `/api/profile/update` | Authenticated | Update user profile |
| POST | `/api/sync-offline` | Officer | Synchronize offline transactions |

All authenticated endpoints require a valid Firebase ID token.

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

## 🛠️ Installation and Deployment

### Prerequisites

- Node.js and npm
- A Firebase project with Authentication and Cloud Firestore
- Firebase configuration and service-account credentials
- Safaricom Daraja credentials for M-PESA integration
- Africa's Talking credentials if SMS notifications are enabled

### Local Setup

```bash
git clone https://github.com/Shelby6898/bungoma-pay.git
cd bungoma-pay
npm install
npm --prefix client install
```

Configure the backend `.env` and frontend `client/.env` files using
the variable names documented above. Never commit either file.

For local testing, use Firebase emulators and M-PESA sandbox credentials.
Do not connect local development to production payment or database resources.

### Build and Quality Checks

```bash
npm --prefix client run build
npm --prefix client run lint
npm test
```

### Run the Application

After configuring a safe local Firebase test environment:

```bash
npm start
```

The Express server serves the built React portals and backend API.

### Render Deployment

The production application is hosted on Render.

- Build command: `npm install && npm --prefix client install && npm --prefix client run build`
- Start command: `npm start`
- Configure production environment variables in the Render dashboard.
- Set `CALLBACK_URL` to the deployed `/api/callback` URL.

Keep Firebase service-account credentials and payment provider secrets
in Render environment settings. Never commit secrets to the repository.

---

## 🗺️ Supported Wards

The application uses nine constituencies and 45 wards, based on the
backend reference data in `location-data.js`.

| Constituency | Wards |
|---|---|
| Kanduyi | Bukembe West, Bukembe East, Township, Khalaba, Musikoma, East Sang’alo, West Sang’alo, Tuuti/Marakaru |
| Bumula | South Bukusu, Bumula, Khasoko, Kabula, Kimaeti, West Bukusu, Siboti |
| Webuye East | Mihuu, Ndivisi, Maraka |
| Webuye West | Sitikho, Matulo, Bokoli, Misikhu |
| Kabuchai | Kabuchai/Chwele, West Nalondo, Bwake/Luuya, Mukuyuni |
| Sirisia | Namwela, Malakisi/South Kulisiru, Lwandanyi |
| Tongaren | Mbakalo, Naitiri/Kabuyefwe, Milima, Ndalu, Tongaren, Soysambu/Mitua |
| Kimilili | Kibingei, Kimilili, Maeni, Kamukuywa |
| Mt Elgon | Cheptais, Chesikaki, Chepyuk, Kapkateny, Kaptama, Elgon |

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
🌐 https://bungoma-pay.onrender.com
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
