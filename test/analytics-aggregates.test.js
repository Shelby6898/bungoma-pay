const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAnalyticsAggregateUpdater
} = require('../analytics-aggregates');

function createHarness() {
  const writes = [];

  const db = {
    collection(name) {
      return {
        doc(id) {
          return { collection: name, id };
        }
      };
    }
  };

  const FieldValue = {
    increment(value) {
      return { increment: value };
    }
  };

  const firestoreTx = {
    set(ref, data, options) {
      writes.push({ ref, data, options });
    }
  };

  const apply = createAnalyticsAggregateUpdater({ db, FieldValue });

  return { apply, firestoreTx, writes };
}

function increments(object) {
  return object;
}

test('new PENDING M-PESA transaction increments all-time and pending counters', async () => {
  const h = createHarness();

  await h.apply(h.firestoreTx, {
    current: {
      status: 'PENDING',
      amount: 1250,
      paymentMethod: 'M-PESA'
    },
    created: true
  });

  const summary = h.writes.find(
    w => w.ref.collection === 'analytics_admin_stats'
  );

  assert.ok(summary);
  assert.equal(summary.ref.id, 'all_time');
  assert.equal(summary.data.allTransactions.increment, 1);
  assert.equal(summary.data.statusSummary.PENDING.transactions.increment, 1);
  assert.equal(summary.data.statusSummary.PENDING.attemptedAmount.increment, 1250);
  assert.equal(summary.data.totalRevenue, undefined);
});

test('new PAID cash transaction increments paid revenue and breakdown', async () => {
  const h = createHarness();

  await h.apply(h.firestoreTx, {
    current: {
      status: 'PAID',
      amount: 250,
      paymentMethod: 'CASH',
      revenueType: 'Parking',
      revenueSubType: 'Daily'
    },
    created: true
  });

  const summary = h.writes.find(
    w => w.ref.collection === 'analytics_admin_stats'
  );

  assert.equal(summary.data.allTransactions.increment, 1);
  assert.equal(summary.data.totalTransactions.increment, 1);
  assert.equal(summary.data.totalRevenue.increment, 250);
  assert.equal(summary.data.cashTotal.increment, 250);
  assert.equal(summary.data.mpesaTotal, undefined);

  const type = h.writes.find(
    w => w.ref.collection === 'analytics_revenue_types'
  );
  const subType = h.writes.find(
    w => w.ref.collection === 'analytics_revenue_subtypes'
  );

  assert.ok(type);
  assert.ok(subType);
  assert.equal(type.data.total.increment, 250);
  assert.equal(subType.data.transactions.increment, 1);
});

test('PENDING to PAID moves counts and adds revenue exactly once', async () => {
  const h = createHarness();

  const changed = await h.apply(h.firestoreTx, {
    previous: {
      status: 'PENDING',
      amount: 1250,
      paymentMethod: 'M-PESA'
    },
    current: {
      status: 'PAID',
      amount: 1250,
      paymentMethod: 'M-PESA',
      revenueType: 'Parking',
      revenueSubType: 'Daily'
    }
  });

  assert.equal(changed, true);

  const summary = h.writes.find(
    w => w.ref.collection === 'analytics_admin_stats'
  );

  assert.equal(summary.data.statusSummary.PENDING.transactions.increment, -1);
  assert.equal(summary.data.statusSummary.PENDING.attemptedAmount.increment, -1250);
  assert.equal(summary.data.statusSummary.PAID.transactions.increment, 1);
  assert.equal(summary.data.statusSummary.PAID.attemptedAmount.increment, 1250);
  assert.equal(summary.data.totalRevenue.increment, 1250);
  assert.equal(summary.data.mpesaTotal.increment, 1250);
  assert.equal(summary.data.allTransactions, undefined);
});

test('PENDING to FAILED changes status counters without adding revenue', async () => {
  const h = createHarness();

  await h.apply(h.firestoreTx, {
    previous: {
      status: 'PENDING',
      amount: 900,
      paymentMethod: 'M-PESA'
    },
    current: {
      status: 'FAILED',
      amount: 900,
      paymentMethod: 'M-PESA'
    }
  });

  const summary = h.writes.find(
    w => w.ref.collection === 'analytics_admin_stats'
  );

  assert.equal(summary.data.statusSummary.PENDING.transactions.increment, -1);
  assert.equal(summary.data.statusSummary.FAILED.transactions.increment, 1);
  assert.equal(summary.data.totalRevenue, undefined);
  assert.equal(summary.data.mpesaTotal, undefined);
});

test('same-status transition makes no aggregate writes', async () => {
  const h = createHarness();

  const changed = await h.apply(h.firestoreTx, {
    previous: {
      status: 'PAID',
      amount: 100,
      paymentMethod: 'CASH'
    },
    current: {
      status: 'PAID',
      amount: 100,
      paymentMethod: 'CASH'
    }
  });

  assert.equal(changed, false);
  assert.equal(h.writes.length, 0);
});
