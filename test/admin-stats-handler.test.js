const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminStatsHandler } = require('../admin-stats-handler');

function makeDb({ migration, summary, types = [], subTypes = [], transactions = [] }) {
  const snapshot = docs => ({
    size: docs.length,
    forEach(callback) {
      docs.forEach((data, index) => callback({
        id: String(index),
        data: () => data
      }));
    }
  });

  return {
    collection(name) {
      return {
        doc(id) {
          let data = null;

          if (name === 'analytics_migrations' && id === 'admin_stats') {
            data = migration;
          }
          if (name === 'analytics_admin_stats' && id === 'all_time') {
            data = summary;
          }

          return {
            async get() {
              return {
                exists: data !== null && data !== undefined,
                data: () => data
              };
            }
          };
        },

        async get() {
          if (name === 'transactions') return snapshot(transactions);
          if (name === 'analytics_revenue_types') return snapshot(types);
          if (name === 'analytics_revenue_subtypes') return snapshot(subTypes);
          return snapshot([]);
        }
      };
    }
  };
}

function responseRecorder() {
  return {
    body: null,
    statusCode: 200,
    json(body) {
      this.body = body;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    }
  };
}

test('uses legacy transaction scan until migration is READY', async () => {
  const db = makeDb({
    migration: { state: 'BACKFILLING' },
    transactions: [
      {
        status: 'PAID',
        amount: 120,
        paymentMethod: 'CASH',
        revenueType: 'Parking',
        revenueSubType: 'Daily'
      },
      { status: 'PENDING', amount: 50, paymentMethod: 'M-PESA' },
      { status: 'FAILED', amount: 20 },
      { status: 'UNKNOWN', amount: 5 }
    ]
  });

  const res = responseRecorder();
  await createAdminStatsHandler({ db })({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.totalTransactions, 1);
  assert.equal(res.body.allTransactions, 4);
  assert.equal(res.body.totalRevenue, 120);
  assert.equal(res.body.cashTotal, 120);
  assert.equal(res.body.mpesaTotal, 0);

  assert.deepEqual(res.body.statusSummary, {
    PAID: { transactions: 1, attemptedAmount: 120 },
    PENDING: { transactions: 1, attemptedAmount: 50 },
    FAILED: { transactions: 1, attemptedAmount: 20 },
    OTHER: { transactions: 1, attemptedAmount: 5 }
  });

  assert.deepEqual(
    res.body.revenueBreakdown.Parking.subTypes.Daily,
    { total: 120, transactions: 1 }
  );
});

test('uses aggregate documents when migration is READY', async () => {
  const db = makeDb({
    migration: { state: 'READY' },
    summary: {
      allTransactions: 4,
      totalTransactions: 2,
      totalRevenue: 300,
      mpesaTotal: 200,
      cashTotal: 100,
      statusSummary: {
        PAID: { transactions: 2, attemptedAmount: 300 },
        PENDING: { transactions: 1, attemptedAmount: 50 },
        FAILED: { transactions: 1, attemptedAmount: 20 }
      }
    },
    types: [
      { name: 'Parking', total: 300, transactions: 2 }
    ],
    subTypes: [
      { stream: 'Parking', name: 'Daily', total: 200, transactions: 1 },
      { stream: 'Parking', name: 'Seasonal', total: 100, transactions: 1 }
    ]
  });

  const res = responseRecorder();
  await createAdminStatsHandler({ db })({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.allTransactions, 4);
  assert.equal(res.body.totalTransactions, 2);
  assert.equal(res.body.totalRevenue, 300);
  assert.equal(res.body.mpesaTotal, 200);
  assert.equal(res.body.cashTotal, 100);

  assert.deepEqual(res.body.statusSummary.OTHER, {
    transactions: 0,
    attemptedAmount: 0
  });

  const parking = res.body.revenueBreakdown.Parking;

  assert.equal(parking.total, 300);
  assert.equal(parking.transactions, 2);
  assert.deepEqual({ ...parking.subTypes }, {
    Daily: { total: 200, transactions: 1 },
    Seasonal: { total: 100, transactions: 1 }
  });
});
