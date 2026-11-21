const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const admin = require('firebase-admin');
const { cert, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const APPLY = process.argv.includes('--apply');
const PAGE_SIZE = 200;
const MAX_SCAN = 5000;

async function main() {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('../firebase-key.json');

  const app = admin.initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id
  });

  const db = getFirestore(app);
  const collection = db.collection('mpesa_callback_inbox');

  let scanned = 0;
  let eligible = 0;
  let updated = 0;
  let cursor = null;

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Maximum records to scan: ${MAX_SCAN}`);

  try {
    while (scanned < MAX_SCAN) {
      const pageSize = Math.min(PAGE_SIZE, MAX_SCAN - scanned);

      let query = collection
        .where('status', '==', 'RECEIVED')
        .limit(pageSize);

      if (cursor) query = query.startAfter(cursor);

      const snapshot = await query.get();
      if (snapshot.empty) break;

      const batch = db.batch();
      let pageUpdates = 0;

      for (const doc of snapshot.docs) {
        scanned++;

        const data = doc.data();
        const changes = {};

        if (!data.nextAttemptAt) {
          changes.nextAttemptAt = Timestamp.fromMillis(Date.now());
        }

        if (!Number.isSafeInteger(data.attemptCount) || data.attemptCount < 0) {
          changes.attemptCount = 0;
        }

        if (typeof data.retryExhausted !== 'boolean') {
          changes.retryExhausted = false;
        }

        if (Object.keys(changes).length === 0) continue;

        eligible++;

        if (APPLY) {
          batch.update(doc.ref, changes);
          pageUpdates++;
        }
      }

      if (APPLY && pageUpdates > 0) {
        await batch.commit();
        updated += pageUpdates;
      }

      cursor = snapshot.docs[snapshot.docs.length - 1];

      if (snapshot.size < pageSize) break;
    }

    console.log('----- BACKFILL SUMMARY -----');
    console.log(`Scanned: ${scanned}`);
    console.log(`Records needing metadata: ${eligible}`);
    console.log(`Records updated: ${updated}`);

    if (scanned >= MAX_SCAN) {
      console.log('Scan limit reached. Run again to inspect remaining records.');
    }

    if (!APPLY) {
      console.log('DRY RUN ONLY: no Firestore documents were changed.');
      console.log('Use --apply only after reviewing this summary.');
    }
  } finally {
    await deleteApp(app);
  }
}

main().catch(error => {
  console.error('Callback retry backfill failed:', error.message);
  process.exitCode = 1;
});
