const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMpesaCallbackRecovery
} = require('../mpesa-callback-recovery');

function clone(value) {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.ms);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    );
  }
  return value;
}

class FakeTimestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
}

function createHarness(records = {}, options = {}) {
  let currentTime = 1_800_000_000_000;
  const store = clone(records);
  const calls = [];

  const ref = (collection, id) => ({
    _collection: collection,
    id
  });

  const db = {
    collection(name) {
      return {
        doc(id) {
          return ref(name, id);
        },
        where(field, operator, value) {
          const filters = [[field, operator, value]];
          const query = {
            where(field, operator, value) {
              filters.push([field, operator, value]);
              return query;
            },
            orderBy(field, direction) {
              query.sortField = field;
              query.direction = direction;
              return query;
            },
            limit(count) {
              query.count = count;
              return query;
            },
            async get() {
              let docs = Object.entries(store[name] || {})
                .filter(([id, data]) => filters.every(([field, op, expected]) => {
                  const actual = data[field];
                  if (actual === undefined) return false;
                  const a = actual?.toMillis ? actual.toMillis() : actual;
                  const b = expected?.toMillis ? expected.toMillis() : expected;
                  return op === '==' ? a === b : op === '<=' ? a <= b : false;
                }))
                .map(([id, data]) => ({
                  id,
                  data: () => clone(data)
                }));

              if (query.sortField) {
                docs.sort((a, b) => {
                  const av = a.data()[query.sortField].toMillis();
                  const bv = b.data()[query.sortField].toMillis();
                  return query.direction === 'desc' ? bv - av : av - bv;
                });
              }
              return { docs: docs.slice(0, query.count) };
            }
          };
          return query;
        }
      };
    },

    async runTransaction(callback) {
      const writes = [];
      const tx = {
        async get(documentRef) {
          const data = store[documentRef._collection]?.[documentRef.id];
          return {
            exists: data !== undefined,
            data: () => data && clone(data)
          };
        },
        update(documentRef, fields) {
          writes.push({ documentRef, fields });
        }
      };

      const result = await callback(tx);
      for (const { documentRef, fields } of writes) {
        Object.assign(
          store[documentRef._collection][documentRef.id],
          clone(fields)
        );
      }
      return result;
    }
  };

  const worker = createMpesaCallbackRecovery({
    db,
    Timestamp: FakeTimestamp,
    workerId: 'worker-test',
    processMpesaCallback: async id => calls.push(id),
    now: () => currentTime,
    ...options
  });

  return { worker, store, calls, setTime: value => currentTime = value };
}

test('processes due RECEIVED callback and schedules first retry', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        nextAttemptAt: new FakeTimestamp(0)
      }
    }
  });

  const result = await h.worker.runOnce();
  const record = h.store.mpesa_callback_inbox.cb1;

  assert.equal(result.processed, 1);
  assert.deepEqual(h.calls, ['cb1']);
  assert.equal(record.attemptCount, 1);
  assert.equal(record.nextAttemptAt.toMillis(), 1_800_000_030_000);
  assert.equal(record.leaseOwner, '');
  assert.equal(record.retryExhausted, false);
});

test('uses exponential backoff for the second attempt', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        attemptCount: 1,
        nextAttemptAt: new FakeTimestamp(0)
      }
    }
  });

  await h.worker.runOnce();

  assert.equal(
    h.store.mpesa_callback_inbox.cb1.nextAttemptAt.toMillis(),
    1_800_000_060_000
  );
  assert.equal(h.store.mpesa_callback_inbox.cb1.attemptCount, 2);
});

test('does not process REVIEW, CONFLICT, or PROCESSED records', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      review: { status: 'REVIEW', nextAttemptAt: new FakeTimestamp(0) },
      conflict: { status: 'CONFLICT', nextAttemptAt: new FakeTimestamp(0) },
      done: { status: 'PROCESSED', nextAttemptAt: new FakeTimestamp(0) }
    }
  });

  const result = await h.worker.runOnce();

  assert.equal(result.processed, 0);
  assert.deepEqual(h.calls, []);
});

test('does not claim a callback with an active lease', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        nextAttemptAt: new FakeTimestamp(0),
        leaseOwner: 'another-worker',
        leaseUntil: new FakeTimestamp(1_800_000_100_000)
      }
    }
  });

  const result = await h.worker.runOnce();

  assert.equal(result.processed, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.mpesa_callback_inbox.cb1.attemptCount, undefined);
});

test('marks the eighth attempt exhausted without changing payment status', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        attemptCount: 7,
        nextAttemptAt: new FakeTimestamp(0)
      }
    }
  });

  const result = await h.worker.runOnce();
  const record = h.store.mpesa_callback_inbox.cb1;

  assert.equal(result.processed, 1);
  assert.equal(record.attemptCount, 8);
  assert.equal(record.retryExhausted, true);
  assert.equal(record.status, 'RECEIVED');
  assert.equal(h.calls.length, 1);

  await h.worker.runOnce();
  assert.equal(h.calls.length, 1);
});

test('does not process callbacks whose retry time is in the future', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        nextAttemptAt: new FakeTimestamp(1_800_000_100_000)
      }
    }
  });

  const result = await h.worker.runOnce();

  assert.equal(result.processed, 0);
  assert.deepEqual(h.calls, []);
});

test('reschedules a callback when the processor throws', async () => {
  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        nextAttemptAt: new FakeTimestamp(0)
      }
    }
  }, {
    processMpesaCallback: async () => {
      throw new Error('temporary provider failure');
    }
  });

  const result = await h.worker.runOnce();
  const record = h.store.mpesa_callback_inbox.cb1;

  assert.equal(result.processed, 1);
  assert.equal(record.status, 'RECEIVED');
  assert.equal(record.attemptCount, 1);
  assert.equal(record.retryExhausted, false);
  assert.equal(record.leaseOwner, '');
  assert.equal(record.nextAttemptAt.toMillis(), 1_800_000_030_000);
});

test('stop waits for an active recovery cycle', async () => {
  let releaseProcessing;
  let signalStarted;

  const processingStarted = new Promise(resolve => {
    signalStarted = resolve;
  });

  const blockedProcessing = new Promise(resolve => {
    releaseProcessing = resolve;
  });

  const h = createHarness({
    mpesa_callback_inbox: {
      cb1: {
        status: 'RECEIVED',
        nextAttemptAt: new FakeTimestamp(0)
      }
    }
  }, {
    processMpesaCallback: async () => {
      signalStarted();
      await blockedProcessing;
    }
  });

  h.worker.start();
  await processingStarted;

  let stopped = false;
  const stopping = h.worker.stop().then(() => {
    stopped = true;
  });

  await Promise.resolve();
  assert.equal(stopped, false);

  releaseProcessing();
  await stopping;

  assert.equal(stopped, true);
  assert.equal(h.store.mpesa_callback_inbox.cb1.leaseOwner, '');
});
