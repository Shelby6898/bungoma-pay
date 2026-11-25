const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const {
  getFirestore,
  FieldValue
} = require('firebase-admin/firestore');

const {
  createMpesaPaymentIntents
} = require('../mpesa-payment-intents');

test('Firestore allows only one competing M-PESA submission claim', {
  timeout: 20000
}, async () => {
  const app = admin.initializeApp(
    { projectId: 'demo-bungoma-pay' },
    `mpesa-intents-race-${process.pid}-${Date.now()}`
  );

  const db = getFirestore(app);

  db.settings({
    host: '127.0.0.1:8080',
    ssl: false
  });

  const idempotencyKey = `race-${process.pid}-${Date.now()}`;
  const helpers = createMpesaPaymentIntents({ db, FieldValue });
  let intentRef;
  let attemptRef;

  try {
    const reserved = await helpers.reserveMpesaIntent({
      uid: 'emulator-officer',
      idempotencyKey,
      phone: '254700000001',
      amount: 1250,
      plate: 'KAA123A',
      revenueType: 'Parking',
      revenueSubType: 'Daily'
    });

    intentRef = reserved.ref;

    assert.equal(reserved.created, true);
    assert.equal(reserved.intent.status, 'RESERVED');

    const results = await Promise.all([
      helpers.claimMpesaSubmission(intentRef, {
        idempotencyKey,
        accountReference: 'KAA123A',
        mpesaTimestamp: '20261125183000'
      }),
      helpers.claimMpesaSubmission(intentRef, {
        idempotencyKey,
        accountReference: 'KAA123A',
        mpesaTimestamp: '20261125183000'
      })
    ]);

    assert.equal(results.filter(result => result.claimed).length, 1);

    const winner = results.find(result => result.claimed);
    const rejected = results.find(result => !result.claimed);
    attemptRef = winner.attemptRef;

    assert.equal(rejected.state, 'SUBMITTING');

    const saved = await intentRef.get();
    assert.equal(saved.data().status, 'SUBMITTING');
    assert.equal(saved.data().attemptCount, 1);
    assert.equal(saved.data().activeAttemptId, attemptRef.id);

    const savedAttempt = await attemptRef.get();
    assert.equal(savedAttempt.exists, true);
    assert.equal(savedAttempt.data().intentId, intentRef.id);
    assert.equal(savedAttempt.data().attemptNumber, 1);
    assert.equal(savedAttempt.data().officerUid, 'emulator-officer');
    assert.equal(savedAttempt.data().idempotencyKey, idempotencyKey);
    assert.equal(savedAttempt.data().accountReference, 'KAA123A');
    assert.equal(savedAttempt.data().darajaTimestamp, '20261125183000');
    assert.equal(savedAttempt.data().status, 'SUBMITTING');

    console.log('PASS: one concurrent Firestore claim creates exactly one attempt');
  } finally {
    if (attemptRef) await attemptRef.delete();
    if (intentRef) await intentRef.delete();
    await app.delete();
  }
});
