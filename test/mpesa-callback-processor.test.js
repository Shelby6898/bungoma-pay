const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMpesaCallbackProcessor
} = require('../mpesa-callback-processor');

const CHECKOUT = 'ws_CO_TEST_001';
const MERCHANT = 'merchant-test-001';

function createHarness({
  inbox = null,
  transaction = null,
  queryError = null,
  queryResponse = {},
  applyAnalyticsAggregates = null,
  onQuery = null
} = {}) {
  const store = {
    mpesa_callback_inbox: {},
    transactions: {}
  };

  if (inbox) store.mpesa_callback_inbox[CHECKOUT] = structuredClone(inbox);
  if (transaction) store.transactions[CHECKOUT] = structuredClone(transaction);

  const pendingTransactions = {
    [CHECKOUT]: { test: true }
  };

  let queryCalls = 0;

  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            _collection: name,
            id,
            async get() {
              const data = store[name]?.[id];
              return {
                exists: data !== undefined,
                data: () => data && structuredClone(data)
              };
            },

            async update(fields) {
              if (!store[name]?.[id]) {
                throw new Error(`Missing document: ${name}/${id}`);
              }
              Object.assign(store[name][id], structuredClone(fields));
            }
          };
        }
      };
    },

    async runTransaction(callback) {
      const writes = [];
      const tx = {
        async get(ref) {
          const name = ref._collection;
          const data = store[name]?.[ref.id];

          return {
            exists: data !== undefined,
            data: () => data && structuredClone(data)
          };
        },

        set(ref, data, options = {}) {
          writes.push({ ref, data: structuredClone(data), options });
        }
      };

      const result = await callback(tx);

      for (const write of writes) {
        const name = write.ref._collection;

        if (!name) throw new Error('Transaction target not found');

        store[name][write.ref.id] = write.options.merge
          ? { ...store[name][write.ref.id], ...write.data }
          : write.data;
      }

      return result;
    }
  };

  const queryMpesaStk = async () => {
    queryCalls++;
    if (queryError) throw queryError;
    if (onQuery) await onQuery(store);

    return {
      ResponseCode: '0',
      CheckoutRequestID: CHECKOUT,
      MerchantRequestID: MERCHANT,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully',
      ...queryResponse
    };
  };

  const process = createMpesaCallbackProcessor({
    db,
    applyAnalyticsAggregates,
    queryMpesaStk,
    pendingTransactions,
    serverTimestamp: () => new Date('2026-11-15T08:00:00Z')
  });

  return {
    process,
    store,
    pendingTransactions,
    get queryCalls() { return queryCalls; }
  };
}

function validInbox(overrides = {}) {
  return {
    status: 'RECEIVED',
    merchantRequestId: MERCHANT,
    resultCode: 0,
    amount: 1250,
    receipt: 'ABC123TEST',
    ...overrides
  };
}

function validTransaction(overrides = {}) {
  return {
    status: 'PENDING',
    paymentMethod: 'M-PESA',
    merchantRequestId: MERCHANT,
    mpesaTimestamp: '20261115080000',
    amount: 1250,
    phone: '254700000000',
    ...overrides
  };
}

test('returns NO_CALLBACK when inbox record is missing', async () => {
  const h = createHarness();
  assert.deepEqual(await h.process(CHECKOUT), { state: 'NO_CALLBACK' });
  assert.equal(h.queryCalls, 0);
});

test('leaves an early callback pending until its transaction exists', async () => {
  const h = createHarness({ inbox: validInbox() });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'NOT_READY' });
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'RECEIVED');
  assert.equal(h.queryCalls, 0);
});

test('marks a valid payment PAID and retains its receipt', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction()
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'PROCESSED' });

  const tx = h.store.transactions[CHECKOUT];
  assert.equal(tx.status, 'PAID');
  assert.equal(tx.callbackReceipt, 'ABC123TEST');
  assert.equal(tx.receiptVerificationStatus, 'PENDING_VERIFICATION');
  assert.equal(tx.checkoutRequestId, CHECKOUT);
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'PROCESSED');
  assert.equal(h.pendingTransactions[CHECKOUT], undefined);
  assert.equal(h.queryCalls, 1);
});

test('updates analytics when a tracked payment becomes PAID', async () => {
  const calls = [];
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction({ analyticsApplied: true }),
    applyAnalyticsAggregates: async (tx, change) => calls.push(change)
  });

  const result = await h.process(CHECKOUT);

  assert.equal(result.state, 'PROCESSED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].previous.status, 'PENDING');
  assert.equal(calls[0].current.status, 'PAID');
  assert.equal(calls[0].previous.analyticsApplied, true);
});

test('updates analytics when a tracked payment becomes FAILED', async () => {
  const calls = [];
  const h = createHarness({
    inbox: validInbox({ resultCode: 1032 }),
    transaction: validTransaction({ analyticsApplied: true }),
    queryResponse: {
      ResultCode: 1032,
      ResultDesc: 'Request cancelled by user'
    },
    applyAnalyticsAggregates: async (tx, change) => calls.push(change)
  });

  const result = await h.process(CHECKOUT);

  assert.equal(result.state, 'FAILED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].previous.status, 'PENDING');
  assert.equal(calls[0].current.status, 'FAILED');
  assert.equal(calls[0].current.analyticsApplied, true);
});

test('preserves createdBy and createdAt when a payment becomes PAID', async () => {
  const createdAt = '2026-11-10T09:30:00.000Z';
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction({
      createdBy: 'officer-123',
      createdAt
    })
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'PROCESSED' });

  const tx = h.store.transactions[CHECKOUT];
  assert.equal(tx.status, 'PAID');
  assert.equal(tx.createdBy, 'officer-123');
  assert.equal(tx.createdAt, createdAt);
});

test('preserves createdBy and createdAt when a payment becomes FAILED', async () => {
  const createdAt = '2026-11-10T09:30:00.000Z';
  const h = createHarness({
    inbox: validInbox({ resultCode: 1032 }),
    transaction: validTransaction({
      createdBy: 'officer-456',
      createdAt
    }),
    queryResponse: {
      ResultCode: 1032,
      ResultDesc: 'Request cancelled by user'
    }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'FAILED' });

  const tx = h.store.transactions[CHECKOUT];
  assert.equal(tx.status, 'FAILED');
  assert.equal(tx.createdBy, 'officer-456');
  assert.equal(tx.createdAt, createdAt);
});

test('does not apply analytics again when retrying after payment is already PAID', async () => {
  let analyticsCalls = 0;
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction({
      status: 'PAID',
      analyticsApplied: true,
      callbackReceipt: 'ORIGINAL123'
    }),
    applyAnalyticsAggregates: async () => {
      analyticsCalls++;
    }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'PROCESSED' });

  assert.equal(analyticsCalls, 0);
  assert.equal(h.store.transactions[CHECKOUT].status, 'PAID');
  assert.equal(h.store.transactions[CHECKOUT].callbackReceipt, 'ORIGINAL123');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'PROCESSED');
});

test('does not update analytics for an unmarked legacy transaction', async () => {
  let calls = 0;
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction(),
    applyAnalyticsAggregates: async () => { calls++; }
  });

  const result = await h.process(CHECKOUT);

  assert.equal(result.state, 'PROCESSED');
  assert.equal(calls, 0);
});

test('does not query Safaricom again for an already processed callback', async () => {
  const h = createHarness({
    inbox: validInbox({ status: 'PROCESSED' }),
    transaction: validTransaction({ status: 'PAID' })
  });

  assert.deepEqual(
    await h.process(CHECKOUT),
    { state: 'PROCESSED', duplicate: true }
  );
  assert.equal(h.queryCalls, 0);
});

test('moves an amount mismatch to REVIEW without marking payment PAID', async () => {
  const h = createHarness({
    inbox: validInbox({ amount: 999 }),
    transaction: validTransaction()
  });

  assert.deepEqual(
    await h.process(CHECKOUT),
    { state: 'AMOUNT_MISMATCH' }
  );

  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
});

test('moves a merchant mismatch to REVIEW', async () => {
  const h = createHarness({
    inbox: validInbox({ merchantRequestId: 'wrong-merchant' }),
    transaction: validTransaction()
  });

  assert.deepEqual(
    await h.process(CHECKOUT),
    { state: 'VERIFICATION_MISMATCH' }
  );

  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
});

test('does not mark payment PAID when inbox becomes CONFLICT during provider verification', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction(),
    onQuery: async store => {
      store.mpesa_callback_inbox[CHECKOUT].status = 'CONFLICT';
    }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'CONFLICT' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'CONFLICT');
  assert.equal(h.pendingTransactions[CHECKOUT].test, true);
  assert.equal(h.queryCalls, 1);
});

test('does not overwrite CONFLICT with REVIEW when verification fails concurrently', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction(),
    queryResponse: { ResponseCode: '1' },
    onQuery: async store => {
      store.mpesa_callback_inbox[CHECKOUT].status = 'CONFLICT';
    }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'CONFLICT' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'CONFLICT');
});

test('keeps the callback RECEIVED if the provider query fails', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction(),
    queryError: new Error('Mock provider unavailable')
  });

  await assert.rejects(
    h.process(CHECKOUT),
    /Mock provider unavailable/
  );

  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'RECEIVED');
});


test('does not query the provider for a conflicting inbox record', async () => {
  const h = createHarness({
    inbox: validInbox({ status: 'CONFLICT' }),
    transaction: validTransaction()
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'CONFLICT' });
  assert.equal(h.queryCalls, 0);
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
});

test('does not query the provider for an inbox record already under review', async () => {
  const h = createHarness({
    inbox: validInbox({ status: 'REVIEW' }),
    transaction: validTransaction()
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'REVIEW' });
  assert.equal(h.queryCalls, 0);
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
});

test('moves an invalid callback result code to REVIEW', async () => {
  const h = createHarness({
    inbox: validInbox({ resultCode: '0' }),
    transaction: validTransaction()
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'INVALID_CALLBACK' });
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.queryCalls, 0);
});

test('marks a verified failed payment FAILED and retains its failure details', async () => {
  const h = createHarness({
    inbox: validInbox({ resultCode: 1032 }),
    transaction: validTransaction(),
    queryResponse: {
      ResultCode: 1032,
      ResultDesc: 'Request cancelled by user'
    }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'FAILED' });

  const tx = h.store.transactions[CHECKOUT];
  assert.equal(tx.status, 'FAILED');
  assert.equal(tx.failureCode, 1032);
  assert.equal(tx.failureDescription, 'Request cancelled by user');
  assert.equal(tx.checkoutRequestId, CHECKOUT);
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'PROCESSED');
  assert.equal(h.pendingTransactions[CHECKOUT], undefined);
  assert.equal(h.queryCalls, 1);
});


test('rejects a non-zero provider response code', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction(),
    queryResponse: { ResponseCode: '1' }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'VERIFICATION_MISMATCH' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
});

test('rejects a provider result code that differs from the callback', async () => {
  const h = createHarness({
    inbox: validInbox({ resultCode: 0 }),
    transaction: validTransaction(),
    queryResponse: { ResultCode: 1032 }
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'VERIFICATION_MISMATCH' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
});

test('does not overwrite an already PAID transaction', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction({
      status: 'PAID',
      callbackReceipt: 'ORIGINAL123'
    })
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'PROCESSED' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PAID');
  assert.equal(h.store.transactions[CHECKOUT].callbackReceipt, 'ORIGINAL123');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'PROCESSED');
});

test('marks receipt verification MISSING when a successful callback has no receipt', async () => {
  const h = createHarness({
    inbox: validInbox({ receipt: '' }),
    transaction: validTransaction()
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'PROCESSED' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PAID');
  assert.equal(h.store.transactions[CHECKOUT].receiptVerificationStatus, 'MISSING');
});

test('moves a transaction in an unexpected state to REVIEW', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction({ status: 'PROCESSING' })
  });

  assert.deepEqual(await h.process(CHECKOUT), { state: 'REVIEW' });
  assert.equal(h.store.transactions[CHECKOUT].status, 'PROCESSING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
});

test('moves a provider checkout ID mismatch to REVIEW', async () => {
  const h = createHarness({
    inbox: validInbox(),
    transaction: validTransaction(),
    queryResponse: { CheckoutRequestID: 'wrong-checkout-id' }
  });

  assert.deepEqual(
    await h.process(CHECKOUT),
    { state: 'VERIFICATION_MISMATCH' }
  );

  assert.equal(h.store.transactions[CHECKOUT].status, 'PENDING');
  assert.equal(h.store.mpesa_callback_inbox[CHECKOUT].status, 'REVIEW');
});
