const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./firebase-key.json');

const {
  createAnalyticsAggregateUpdater
} = require('./analytics-aggregates');

const APPLY = process.argv.includes('--apply');
const confirmArg = process.argv.find(arg =>
  arg.startsWith('--confirm-project=')
);

const PAGE_SIZE = 200;
const MAX_DOCS_ARG = process.argv.find(arg =>
  arg.startsWith('--max-docs=')
);
const MAX_DOCS = MAX_DOCS_ARG
  ? Number(MAX_DOCS_ARG.split('=')[1])
  : Infinity;

async function main() {
  const projectId = serviceAccount.project_id;

  if (!projectId) {
    throw new Error('Firebase project_id is missing from service account');
  }

  if (APPLY && confirmArg !== `--confirm-project=${projectId}`) {
    throw new Error(
      `Apply blocked. Confirm the exact project using --confirm-project=${projectId}`
    );
  }

  if (!Number.isInteger(MAX_DOCS) && MAX_DOCS !== Infinity) {
    throw new Error('Invalid --max-docs value');
  }

  if (MAX_DOCS <= 0) {
    throw new Error('--max-docs must be greater than zero');
  }

  admin.initializeApp({
    credential: cert(serviceAccount),
    projectId
  });

  const db = getFirestore();

  const applyAnalyticsAggregates = createAnalyticsAggregateUpdater({
    db,
    FieldValue
  });

  const migrationRef = db
    .collection('analytics_migrations')
    .doc('admin_stats');

  console.log('Project:', projectId);
  console.log(
    'Firestore emulator:',
    process.env.FIRESTORE_EMULATOR_HOST || 'not configured'
  );
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Page size:', PAGE_SIZE);
  console.log(
    'Maximum documents:',
    MAX_DOCS === Infinity ? 'unlimited' : MAX_DOCS
  );

  if (APPLY) {
    await migrationRef.set({
      state: 'BACKFILLING',
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  let lastDoc = null;
  let inspected = 0;
  let needingBackfill = 0;
  let applied = 0;
  let skipped = 0;

  while (inspected < MAX_DOCS) {
    let query = db.collection('transactions')
      .orderBy(FieldPath.documentId())
      .limit(Math.min(PAGE_SIZE, MAX_DOCS - inspected));

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const page = await query.get();

    if (page.empty) break;

    for (const doc of page.docs) {
      inspected++;

      if (doc.data().analyticsApplied !== true) {
        needingBackfill++;

        if (APPLY) {
          const result = await db.runTransaction(async tx => {
            const latestSnap = await tx.get(doc.ref);

            if (!latestSnap.exists) return 'skipped';

            const latest = latestSnap.data();

            if (latest.analyticsApplied === true) {
              return 'skipped';
            }

            await applyAnalyticsAggregates(tx, {
              current: latest,
              created: true
            });

            tx.update(doc.ref, {
              analyticsApplied: true
            });

            return 'applied';
          });

          if (result === 'applied') applied++;
          else skipped++;
        }
      }

      if (inspected % 100 === 0) {
        console.log(
          `Progress: inspected=${inspected}, needing=${needingBackfill}, applied=${applied}, skipped=${skipped}`
        );
      }
    }

    lastDoc = page.docs[page.docs.length - 1];

    if (page.size < PAGE_SIZE) break;
  }

  if (APPLY && inspected < MAX_DOCS) {
    await migrationRef.set({
      state: 'READY',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      inspected,
      applied,
      skipped
    }, { merge: true });
  }

  console.log('\n===== BACKFILL SUMMARY =====');
  console.log('Inspected:', inspected);
  console.log('Needing backfill:', needingBackfill);

  if (APPLY) {
    console.log('Applied:', applied);
    console.log('Skipped:', skipped);
    console.log(
      inspected >= MAX_DOCS
        ? 'Migration remains BACKFILLING: document limit reached.'
        : 'Migration state: READY'
    );
  } else {
    console.log('DRY RUN ONLY — no Firestore documents were changed.');
  }
}

main()
  .catch(error => {
    console.error('Backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (admin.apps.length) {
      await admin.app().delete();
    }
  });
