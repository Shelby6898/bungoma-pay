function statusOf(data) {
  const status = String(data?.status || '').toUpperCase();
  return ['PAID', 'PENDING', 'FAILED'].includes(status) ? status : 'OTHER';
}

function amountOf(data) {
  const amount = Number(data?.amount) || 0;
  return Number.isFinite(amount) ? amount : 0;
}

function revenueLabels(data) {
  return {
    stream: String(data?.revenueType || '').trim() || 'Unclassified',
    subType: String(data?.revenueSubType || '').trim() || 'Unspecified'
  };
}

function createAnalyticsAggregateUpdater({ db, FieldValue }) {
  if (!db || !FieldValue || typeof FieldValue.increment !== 'function') {
    throw new Error('Missing analytics aggregate dependencies');
  }

  const inc = value => FieldValue.increment(value);

  return async function applyAnalyticsAggregates(
    firestoreTx,
    { current, previous = null, created = false }
  ) {
    if (!current) throw new Error('Missing transaction data');

    const oldStatus = previous ? statusOf(previous) : null;
    const newStatus = statusOf(current);

    if (previous && oldStatus === newStatus) {
      return false;
    }

    const summary = {
      statusSummary: {}
    };

    if (created) {
      summary.allTransactions = inc(1);
    }

    function updateStatus(status, data, direction) {
      const amount = amountOf(data);

      if (!summary.statusSummary[status]) {
        summary.statusSummary[status] = {
          transactions: inc(0),
          attemptedAmount: inc(0)
        };
      }

      summary.statusSummary[status].transactions = inc(direction);
      summary.statusSummary[status].attemptedAmount = inc(amount * direction);

      if (status !== 'PAID') return;

      summary.totalTransactions = inc(direction);
      summary.totalRevenue = inc(amount * direction);

      const method = String(data.paymentMethod || '').toUpperCase();
      if (method === 'M-PESA') {
        summary.mpesaTotal = inc(amount * direction);
      } else if (method === 'CASH') {
        summary.cashTotal = inc(amount * direction);
      }

      const { stream, subType } = revenueLabels(data);
      const typeId = Buffer.from(stream).toString('base64url');
      const subTypeId = Buffer.from(
        JSON.stringify([stream, subType])
      ).toString('base64url');

      const typeRef = db.collection('analytics_revenue_types').doc(typeId);
      const subTypeRef = db.collection('analytics_revenue_subtypes').doc(subTypeId);

      const typePatch = {
        name: stream,
        total: inc(amount * direction),
        transactions: inc(direction)
      };

      const subTypePatch = {
        stream,
        name: subType,
        total: inc(amount * direction),
        transactions: inc(direction)
      };

      firestoreTx.set(typeRef, typePatch, { merge: true });
      firestoreTx.set(subTypeRef, subTypePatch, { merge: true });
    }

    if (previous) {
      updateStatus(oldStatus, previous, -1);
    }

    updateStatus(newStatus, current, 1);

    firestoreTx.set(
      db.collection('analytics_admin_stats').doc('all_time'),
      summary,
      { merge: true }
    );

    return true;
  };
}

module.exports = {
  createAnalyticsAggregateUpdater,
  statusOf,
  amountOf,
  revenueLabels
};
