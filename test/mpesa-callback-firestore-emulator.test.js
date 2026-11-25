const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const {
  getFirestore,
  FieldValue
} = require('firebase-admin/firestore');

const {
  createMpesaCallbackProcessor
} = require('../mpesa-callback-processor');

test('Firestore preserves CONFLICT during callback processing', {
  timeout: 20000
}, async () => {
  const app = admin.initializeApp(
    { projectId: 'demo-bungoma-pay' },
    `mpesa-race-${process.pid}-${Date.now()}`
  );

  const db = getFirestore(app);

  db.settings({
    host: '127.0.0.1:8080',
    ssl: false
  });

  const checkoutId = `race_${process.pid}_${Date.now()}`;
  const merchantId = 'merchant-race-test';

  const inboxRef = db.collection('mpesa_callback_inbox')
    .doc(checkoutId);

  const paymentRef = db.collection('transactions')
    .doc(checkoutId);

  let analyticsCalls = 0;

  const pendingTransactions = {
    [checkoutId]: { test: true }
  };

  try {
    await inboxRef.set({
      status: 'RECEIVED',
      merchantRequestId: merchantId,
      resultCode: 0,
      amount: 1250,
      receipt: 'RACE-TEST-001'
    });

    await paymentRef.set({
      status: 'PENDING',
      paymentMethod: 'M-PESA',
      merchantRequestId: merchantId,
      mpesaTimestamp: '20261125080000',
      amount: 1250,
      analyticsApplied: true,
      revenueType: 'Parking',
      revenueSubType: 'Daily'
    });

    const process = createMpesaCallbackProcessor({
      db,
      pendingTransactions,
      serverTimestamp: () => FieldValue.serverTimestamp(),

      applyAnalyticsAggregates: async () => {
        analyticsCalls++;
      },

      queryMpesaStk: async () => {
        // Simulate a competing callback changing the inbox.
        await db.runTransaction(async tx => {
          const snap = await tx.get(inboxRef);
          assert.equal(snap.data().status, 'RECEIVED');

          tx.update(inboxRef, {
            status: 'CONFLICT',
            conflictDetectedAt: FieldValue.serverTimestamp()
          });
        });

        return {
          ResponseCode: '0',
          CheckoutRequestID: checkoutId,
          MerchantRequestID: merchantId,
          ResultCode: 0,
          ResultDesc: 'Success'
        };
      }
    });

    const result = await process(checkoutId);

    assert.equal(result.state, 'CONFLICT');

    const inbox = (await inboxRef.get()).data();
    const payment = (await paymentRef.get()).data();

    assert.equal(inbox.status, 'CONFLICT');
    assert.equal(payment.status, 'PENDING');
    assert.equal(analyticsCalls, 0);
    assert.ok(pendingTransactions[checkoutId]);

    console.log('PASS: real Firestore preserves callback CONFLICT');
    console.log('PASS: conflicting callback cannot mark payment PAID');
    console.log('PASS: analytics updater is not called');
  } finally {
    await Promise.all([
      inboxRef.delete(),
      paymentRef.delete()
    ]);

    delete pendingTransactions[checkoutId];
    await app.delete();
  }
});
