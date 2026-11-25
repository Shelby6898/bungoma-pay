const { randomUUID } = require('node:crypto');

const COLLECTION = 'mpesa_callback_inbox';

function createMpesaCallbackRecovery({
  db,
  processMpesaCallback,
  Timestamp,
  workerId = randomUUID(),
  batchSize = 20,
  maxAttempts = 8,
  baseDelayMs = 30_000,
  maxDelayMs = 30 * 60_000,
  leaseMs = 2 * 60_000,
  intervalMs = 30_000,
  now = () => Date.now()
} = {}) {
  if (!db || typeof processMpesaCallback !== 'function' ||
      !Timestamp || typeof Timestamp.fromMillis !== 'function') {
    throw new Error('Missing M-PESA recovery worker dependency');
  }

  if (!Number.isSafeInteger(batchSize) || batchSize < 1 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
      baseDelayMs < 1 || maxDelayMs < baseDelayMs ||
      leaseMs < 1 || intervalMs < 1) {
    throw new Error('Invalid M-PESA recovery worker configuration');
  }

  let running = false;
  let timer = null;
  let cycleInProgress = false;
  let activeCycle = null;

  const timestamp = value => Timestamp.fromMillis(value);

  async function claim(ref) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;

      const data = snap.data();
      const currentTime = now();

      if (data.status !== 'RECEIVED' || data.retryExhausted === true) {
        return null;
      }

      const nextAttempt = data.nextAttemptAt;
      if (nextAttempt && typeof nextAttempt.toMillis === 'function' &&
          nextAttempt.toMillis() > currentTime) {
        return null;
      }

      const leaseUntil = data.leaseUntil;
      if (data.leaseOwner && leaseUntil &&
          typeof leaseUntil.toMillis === 'function' &&
          leaseUntil.toMillis() > currentTime) {
        return null;
      }

      const previousAttempts = Number.isSafeInteger(data.attemptCount)
        ? data.attemptCount
        : 0;

      if (previousAttempts >= maxAttempts) {
        tx.update(ref, {
          retryExhausted: true,
          leaseOwner: '',
          leaseUntil: timestamp(0)
        });
        return null;
      }

      const attemptCount = previousAttempts + 1;

      tx.update(ref, {
        attemptCount,
        lastAttemptAt: timestamp(currentTime),
        leaseOwner: workerId,
        leaseUntil: timestamp(currentTime + leaseMs)
      });

      return { attemptCount };
    });
  }

  async function finish(ref, attemptCount) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data();

      // Never overwrite a callback that the processor has already
      // marked PROCESSED, REVIEW, or CONFLICT.
      if (data.status !== 'RECEIVED' || data.leaseOwner !== workerId) {
        return;
      }

      const updates = {
        leaseOwner: '',
        leaseUntil: timestamp(0)
      };

      const exhausted = attemptCount >= maxAttempts;
      const delay = Math.min(
        baseDelayMs * (2 ** Math.min(attemptCount - 1, 20)),
        maxDelayMs
      );

      updates.retryExhausted = exhausted;
      updates.nextAttemptAt = timestamp(
        exhausted ? now() + 365 * 24 * 60 * 60 * 1000 : now() + delay
      );

      tx.update(ref, updates);
    });
  }

  async function processClaim(ref, attemptCount) {
    try {
      await processMpesaCallback(ref.id);
    } catch (error) {
      console.error('M-PESA callback recovery attempt failed; attempt:', attemptCount);
    }

    await finish(ref, attemptCount);
  }

  async function runOnce() {
    if (cycleInProgress) {
      return { skipped: true, processed: 0 };
    }

    cycleInProgress = true;
    let processed = 0;

    try {
      const due = await db.collection(COLLECTION)
        .where('status', '==', 'RECEIVED')
        .where('nextAttemptAt', '<=', timestamp(now()))
        .orderBy('nextAttemptAt', 'asc')
        .limit(batchSize)
        .get();

      for (const doc of due.docs) {
        const ref = db.collection(COLLECTION).doc(doc.id);
        const claimed = await claim(ref);

        if (!claimed) continue;

        await processClaim(ref, claimed.attemptCount);
        processed++;
      }

      return { skipped: false, processed };
    } finally {
      cycleInProgress = false;
    }
  }

  function start() {
    if (running) return;

    running = true;

    const cycle = () => {
      if (activeCycle) return;

      activeCycle = runOnce()
        .catch(error => {
          console.error('M-PESA recovery worker cycle failed');
        })
        .finally(() => {
          activeCycle = null;
        });
    };

    cycle();
    timer = setInterval(cycle, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    running = false;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    return activeCycle || Promise.resolve();
  }

  return { runOnce, start, stop };
}

module.exports = { createMpesaCallbackRecovery };
