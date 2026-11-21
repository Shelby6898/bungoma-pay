const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  createAnalyticsAggregateUpdater
} = require('../analytics-aggregates');

async function main() {
  const app = admin.initializeApp({ projectId: 'demo-bungoma-pay' });
  const db = getFirestore(app);

  db.settings({
    host: '127.0.0.1:8080',
    ssl: false
  });

  const apply = createAnalyticsAggregateUpdater({
    db,
    FieldValue: FieldValue
  });

  const typeId = Buffer.from('Parking').toString('base64url');
  const subTypeId = Buffer.from(
    JSON.stringify(['Parking', 'Daily'])
  ).toString('base64url');

  const summaryRef = db.collection('analytics_admin_stats').doc('all_time');
  const typeRef = db.collection('analytics_revenue_types').doc(typeId);
  const subTypeRef = db.collection('analytics_revenue_subtypes').doc(subTypeId);

  // Isolate this test from previous emulator runs.
  await Promise.all([
    summaryRef.delete(),
    typeRef.delete(),
    subTypeRef.delete()
  ]);

  const pending = {
    status: 'PENDING',
    amount: 1250,
    paymentMethod: 'M-PESA',
    revenueType: 'Parking',
    revenueSubType: 'Daily'
  };

  await db.runTransaction(async tx => {
    await apply(tx, { current: pending, created: true });
  });

  const paid = { ...pending, status: 'PAID' };

  await db.runTransaction(async tx => {
    await apply(tx, { previous: pending, current: paid });
  });

  const summarySnap = await db
    .collection('analytics_admin_stats')
    .doc('all_time')
    .get();

  assert.equal(summarySnap.exists, true);
  const summary = summarySnap.data();

  assert.equal(summary.allTransactions, 1);
  assert.equal(summary.totalTransactions, 1);
  assert.equal(summary.totalRevenue, 1250);
  assert.equal(summary.mpesaTotal, 1250);
  assert.equal(summary.statusSummary.PENDING.transactions, 0);
  assert.equal(summary.statusSummary.PENDING.attemptedAmount, 0);
  assert.equal(summary.statusSummary.PAID.transactions, 1);
  assert.equal(summary.statusSummary.PAID.attemptedAmount, 1250);

  const typeSnap = await db
    .collection('analytics_revenue_types')
    .doc(typeId)
    .get();

  const subTypeSnap = await db
    .collection('analytics_revenue_subtypes')
    .doc(subTypeId)
    .get();

  assert.equal(typeSnap.data().total, 1250);
  assert.equal(typeSnap.data().transactions, 1);
  assert.equal(subTypeSnap.data().total, 1250);
  assert.equal(subTypeSnap.data().transactions, 1);

  // Leave the emulator clean for the next test run.
  await Promise.all([
    summaryRef.delete(),
    typeRef.delete(),
    subTypeRef.delete()
  ]);

  console.log('PASS: Firestore nested increment transforms');
  console.log('PASS: PENDING to PAID aggregate transition');
  console.log('PASS: all-time totals and revenue breakdown');

  await app.delete();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
