const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMpesaPaymentIntents
} = require('../mpesa-payment-intents');

function createHarness() {
  const store = new Map();
  let transactionQueue = Promise.resolve();

  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            collection: name,
            id
          };
        }
      };
    },

    async runTransaction(callback) {
      const run = transactionQueue.then(async () => {
        const writes = [];

        const tx = {
          async get(ref) {
            const data = store.get(`${ref.collection}/${ref.id}`);

            return {
              exists: data !== undefined,
              data: () => data && structuredClone(data)
            };
          },

          create(ref, data) {
            writes.push({ type: 'create', ref, data });
          },

          update(ref, fields) {
            writes.push({ type: 'update', ref, fields });
          }
        };

        const result = await callback(tx);

        for (const write of writes) {
          const key = `${write.ref.collection}/${write.ref.id}`;

          if (write.type === 'create') {
            if (store.has(key)) {
              throw new Error('Document already exists');
            }

            store.set(key, structuredClone(write.data));
          } else {
            const current = store.get(key);

            if (!current) {
              throw new Error('Document does not exist');
            }

            store.set(key, {
              ...current,
              ...structuredClone(write.fields)
            });
          }
        }

        return result;
      });

      transactionQueue = run.catch(() => {});
      return run;
    }
  };

  const FieldValue = {
    serverTimestamp: () => 'TEST_TIMESTAMP'
  };

  return {
    store,
    ...createMpesaPaymentIntents({ db, FieldValue })
  };
}

const request = {
  uid: 'officer-001',
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  phone: '254700000000',
  amount: 1250,
  plate: 'KDA123A',
  revenueType: 'Parking',
  revenueSubType: 'Daily'
};

test('creates a new RESERVED payment intent', async () => {
  const h = createHarness();

  const result = await h.reserveMpesaIntent(request);

  assert.equal(result.created, true);
  assert.equal(result.intent.status, 'RESERVED');
  assert.equal(result.intent.createdBy, request.uid);
  assert.equal(result.intent.amount, request.amount);
  assert.equal(result.intent.createdAt, 'TEST_TIMESTAMP');
  assert.equal(h.store.size, 1);
});

test('reuses an identical reservation without creating another document', async () => {
  const h = createHarness();

  const first = await h.reserveMpesaIntent(request);
  const second = await h.reserveMpesaIntent(request);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.ref.id, first.ref.id);
  assert.equal(h.store.size, 1);
});

test('rejects different payment details using the same idempotency key', async () => {
  const h = createHarness();

  await h.reserveMpesaIntent(request);

  await assert.rejects(
    h.reserveMpesaIntent({
      ...request,
      amount: 2500
    }),
    error => error.statusCode === 409
  );

  assert.equal(h.store.size, 1);
});

test('uses a different reservation for a different officer', async () => {
  const h = createHarness();

  const first = await h.reserveMpesaIntent(request);
  const second = await h.reserveMpesaIntent({
    ...request,
    uid: 'officer-002'
  });

  assert.notEqual(first.ref.id, second.ref.id);
  assert.equal(h.store.size, 2);
});

test('returns NOT_FOUND when claiming a missing intent', async () => {
  const h = createHarness();

  const result = await h.claimMpesaSubmission({
    collection: 'payment_intents',
    id: 'missing'
  });

  assert.deepEqual(result, {
    claimed: false,
    state: 'NOT_FOUND'
  });
});

test('creates one immutable attempt for a successful claim', async () => {
  const h = createHarness();
  const reservation = await h.reserveMpesaIntent(request);

  const first = await h.claimMpesaSubmission(reservation.ref, {
    idempotencyKey: request.idempotencyKey,
    accountReference: 'KDA123A',
    mpesaTimestamp: '20261125183000'
  });
  const second = await h.claimMpesaSubmission(reservation.ref);

  assert.equal(first.claimed, true);
  assert.equal(first.state, 'SUBMITTING');
  assert.equal(first.attemptNumber, 1);
  assert.ok(first.attemptId);
  assert.equal(first.attemptRef.id, first.attemptId);

  assert.equal(second.claimed, false);
  assert.equal(second.state, 'SUBMITTING');

  const savedIntent = h.store.get(
    `payment_intents/${reservation.ref.id}`
  );
  const savedAttempt = h.store.get(
    `payment_attempts/${first.attemptId}`
  );

  assert.equal(savedIntent.status, 'SUBMITTING');
  assert.equal(savedIntent.attemptCount, 1);
  assert.equal(savedIntent.activeAttemptId, first.attemptId);
  assert.equal(savedIntent.submissionStartedAt, 'TEST_TIMESTAMP');

  assert.equal(savedAttempt.intentId, reservation.ref.id);
  assert.equal(savedAttempt.attemptNumber, 1);
  assert.equal(savedAttempt.officerUid, request.uid);
  assert.equal(savedAttempt.idempotencyKey, request.idempotencyKey);
  assert.equal(savedAttempt.phone, request.phone);
  assert.equal(savedAttempt.amount, request.amount);
  assert.equal(savedAttempt.plate, request.plate);
  assert.equal(savedAttempt.accountReference, 'KDA123A');
  assert.equal(savedAttempt.revenueType, request.revenueType);
  assert.equal(savedAttempt.revenueSubType, request.revenueSubType);
  assert.equal(savedAttempt.darajaTimestamp, '20261125183000');
  assert.equal(savedAttempt.status, 'SUBMITTING');
  assert.equal(h.store.size, 2);
});

test('competing claims create exactly one attempt', async () => {
  const h = createHarness();
  const reservation = await h.reserveMpesaIntent(request);

  const results = await Promise.all([
    h.claimMpesaSubmission(reservation.ref, {
      idempotencyKey: request.idempotencyKey,
      accountReference: 'KDA123A',
      mpesaTimestamp: '20261125183000'
    }),
    h.claimMpesaSubmission(reservation.ref, {
      idempotencyKey: request.idempotencyKey,
      accountReference: 'KDA123A',
      mpesaTimestamp: '20261125183000'
    })
  ]);

  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal(results.filter(result => !result.claimed).length, 1);

  const winner = results.find(result => result.claimed);
  const saved = h.store.get(
    `payment_intents/${reservation.ref.id}`
  );

  assert.equal(saved.status, 'SUBMITTING');
  assert.equal(saved.attemptCount, 1);
  assert.equal(saved.activeAttemptId, winner.attemptId);

  const attempts = [...h.store.entries()].filter(
    ([key]) => key.startsWith('payment_attempts/')
  );

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0][1].status, 'SUBMITTING');
});

test('does not claim an intent already marked SUBMISSION_UNKNOWN', async () => {
  const h = createHarness();
  const reservation = await h.reserveMpesaIntent(request);

  await h.claimMpesaSubmission(reservation.ref);

  await h.store.set(
    `payment_intents/${reservation.ref.id}`,
    {
      ...h.store.get(`payment_intents/${reservation.ref.id}`),
      status: 'SUBMISSION_UNKNOWN'
    }
  );

  const result = await h.claimMpesaSubmission(reservation.ref);

  assert.equal(result.claimed, false);
  assert.equal(result.state, 'SUBMISSION_UNKNOWN');
});
