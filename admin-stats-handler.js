function createAdminStatsHandler({ db }) {
  return async (req, res) => {
    try {
      const migrationSnap = await db
        .collection('analytics_migrations')
        .doc('admin_stats')
        .get();

      if (migrationSnap.exists && migrationSnap.data().state === 'READY') {
        const [summarySnap, typesSnap, subTypesSnap] = await Promise.all([
          db.collection('analytics_admin_stats').doc('all_time').get(),
          db.collection('analytics_revenue_types').get(),
          db.collection('analytics_revenue_subtypes').get()
        ]);

        const aggregate = summarySnap.exists ? summarySnap.data() : {};
        const storedStatuses = aggregate.statusSummary || {};

        const statusSummary = {
          PAID: { transactions: 0, attemptedAmount: 0 },
          PENDING: { transactions: 0, attemptedAmount: 0 },
          FAILED: { transactions: 0, attemptedAmount: 0 },
          OTHER: { transactions: 0, attemptedAmount: 0 }
        };

        for (const status of Object.keys(statusSummary)) {
          const stored = storedStatuses[status] || {};
          statusSummary[status] = {
            transactions: Number(stored.transactions) || 0,
            attemptedAmount: Number(stored.attemptedAmount) || 0
          };
        }

        const revenueBreakdown = Object.create(null);

        typesSnap.forEach(doc => {
          const data = doc.data();
          const stream = String(data.name || 'Unclassified');

          revenueBreakdown[stream] = {
            total: Number(data.total) || 0,
            transactions: Number(data.transactions) || 0,
            subTypes: Object.create(null)
          };
        });

        subTypesSnap.forEach(doc => {
          const data = doc.data();
          const stream = String(data.stream || 'Unclassified');
          const subType = String(data.name || 'Unspecified');

          if (!revenueBreakdown[stream]) {
            revenueBreakdown[stream] = {
              total: 0,
              transactions: 0,
              subTypes: Object.create(null)
            };
          }

          revenueBreakdown[stream].subTypes[subType] = {
            total: Number(data.total) || 0,
            transactions: Number(data.transactions) || 0
          };
        });

        return res.json({
          success: true,
          totalTransactions: Number(aggregate.totalTransactions) || 0,
          allTransactions: Number(aggregate.allTransactions) || 0,
          statusSummary,
          totalRevenue: Number(aggregate.totalRevenue) || 0,
          mpesaTotal: Number(aggregate.mpesaTotal) || 0,
          cashTotal: Number(aggregate.cashTotal) || 0,
          revenueBreakdown
        });
      }

      // Legacy full-scan fallback until the aggregate migration is READY.
      const snapshot = await db.collection('transactions').get();

      let totalRevenue = 0;
      let mpesaTotal = 0;
      let cashTotal = 0;
      let totalTransactions = 0;

      const statusSummary = {
        PAID: { transactions: 0, attemptedAmount: 0 },
        PENDING: { transactions: 0, attemptedAmount: 0 },
        FAILED: { transactions: 0, attemptedAmount: 0 },
        OTHER: { transactions: 0, attemptedAmount: 0 }
      };

      const revenueBreakdown = Object.create(null);

      snapshot.forEach(doc => {
        const d = doc.data();
        const amount = Number(d.amount) || 0;
        const rawStatus = String(d.status || '').toUpperCase();
        const status = Object.prototype.hasOwnProperty.call(statusSummary, rawStatus)
          ? rawStatus
          : 'OTHER';

        statusSummary[status].transactions++;
        statusSummary[status].attemptedAmount += amount;

        if (status !== 'PAID') return;

        totalTransactions++;
        totalRevenue += amount;

        const method = String(d.paymentMethod || '').toUpperCase();
        if (method === 'M-PESA') mpesaTotal += amount;
        else if (method === 'CASH') cashTotal += amount;

        const stream = String(d.revenueType || '').trim() || 'Unclassified';
        const subType = String(d.revenueSubType || '').trim() || 'Unspecified';

        if (!revenueBreakdown[stream]) {
          revenueBreakdown[stream] = {
            total: 0,
            transactions: 0,
            subTypes: Object.create(null)
          };
        }

        revenueBreakdown[stream].total += amount;
        revenueBreakdown[stream].transactions++;

        if (!revenueBreakdown[stream].subTypes[subType]) {
          revenueBreakdown[stream].subTypes[subType] = {
            total: 0,
            transactions: 0
          };
        }

        revenueBreakdown[stream].subTypes[subType].total += amount;
        revenueBreakdown[stream].subTypes[subType].transactions++;
      });

      return res.json({
        success: true,
        totalTransactions,
        allTransactions: snapshot.size,
        statusSummary,
        totalRevenue,
        mpesaTotal,
        cashTotal,
        revenueBreakdown
      });
    } catch (error) {
      console.error('Admin stats request failed.');
      return res.status(500).json({
        success: false,
        error: 'Could not load administrator statistics.'
      });
    }
  };
}

module.exports = { createAdminStatsHandler };
