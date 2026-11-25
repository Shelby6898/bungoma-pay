function createMpesaCallbackProcessor({
  db,
  applyAnalyticsAggregates,
  queryMpesaStk,
  pendingTransactions,
  serverTimestamp
}) {
  if (
    !db ||
    typeof queryMpesaStk !== 'function' ||
    !pendingTransactions ||
    typeof serverTimestamp !== 'function'
  ) {
    throw new Error('Missing M-PESA callback processor dependency');
  }

  function sameCallback(saved, expected) {
    return (
      saved.merchantRequestId === expected.merchantRequestId &&
      saved.resultCode === expected.resultCode &&
      saved.amount === expected.amount &&
      saved.receipt === expected.receipt
    );
  }

  async function markReviewIfCurrent(inboxRef, expected) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(inboxRef);

      if (!snap.exists) return 'NO_CALLBACK';

      const current = snap.data();

      if (current.status !== 'RECEIVED') {
        return current.status || 'UNKNOWN';
      }

      if (!sameCallback(current, expected)) {
        return current.status || 'CONFLICT';
      }

      tx.set(inboxRef, {
        status: 'REVIEW',
        reviewDetectedAt: serverTimestamp()
      }, { merge: true });

      return 'REVIEW';
    });
  }

  async function processMpesaCallback(checkoutId) {
    const inboxRef = db.collection('mpesa_callback_inbox').doc(checkoutId);
    const inboxSnap = await inboxRef.get();

    if (!inboxSnap.exists) return { state: 'NO_CALLBACK' };

    const inbox = inboxSnap.data();

    if (inbox.status === 'PROCESSED') {
      return { state: 'PROCESSED', duplicate: true };
    }

    if (inbox.status === 'CONFLICT' || inbox.status === 'REVIEW') {
      return { state: inbox.status };
    }

    const expectedCallback = {
      merchantRequestId: inbox.merchantRequestId,
      resultCode: inbox.resultCode,
      amount: inbox.amount,
      receipt: inbox.receipt
    };

    const callbackMerchantId = String(inbox.merchantRequestId || '');
    const resultCode = inbox.resultCode;
    const callbackAmount = inbox.amount;
    const receipt = String(inbox.receipt || '');

    if (!Number.isSafeInteger(resultCode) || resultCode < 0) {
      const state = await markReviewIfCurrent(inboxRef, expectedCallback);
      return { state: state === 'REVIEW' ? 'INVALID_CALLBACK' : state };
    }

    const ref = db.collection('transactions').doc(checkoutId);
    const attemptSnap = await ref.get();
    const attempt = attemptSnap.exists ? attemptSnap.data() : null;

    if (!attempt || !attempt.mpesaTimestamp || !attempt.merchantRequestId) {
      return { state: 'NOT_READY' };
    }

    const queryData = await queryMpesaStk(checkoutId, attempt.mpesaTimestamp);
    const rawVerifiedResultCode = queryData?.ResultCode;
    const verifiedResultCode =
      typeof rawVerifiedResultCode === 'number'
        ? rawVerifiedResultCode
        : typeof rawVerifiedResultCode === 'string' &&
            /^\d+$/.test(rawVerifiedResultCode.trim())
          ? Number(rawVerifiedResultCode.trim())
          : NaN;

    const verifiedCheckoutId = String(queryData?.CheckoutRequestID || '');
    const verifiedMerchantId = String(queryData?.MerchantRequestID || '');

    if (
      String(queryData?.ResponseCode) !== '0' ||
      verifiedCheckoutId !== checkoutId ||
      callbackMerchantId !== String(attempt.merchantRequestId) ||
      verifiedMerchantId !== String(attempt.merchantRequestId) ||
      !Number.isSafeInteger(verifiedResultCode) ||
      verifiedResultCode < 0 ||
      verifiedResultCode !== resultCode
    ) {
      console.log('M-PESA callback/query verification mismatch:', checkoutId);
      const state = await markReviewIfCurrent(inboxRef, expectedCallback);
      return {
        state: state === 'REVIEW' ? 'VERIFICATION_MISMATCH' : state
      };
    }

    let callbackAmountNumber = NaN;

    if (verifiedResultCode === 0) {
      callbackAmountNumber = Number(callbackAmount);
      const attemptAmount = Number(attempt.amount);

      if (
        !Number.isSafeInteger(attemptAmount) ||
        attemptAmount < 1 ||
        !Number.isSafeInteger(callbackAmountNumber) ||
        callbackAmountNumber !== attemptAmount
      ) {
        console.log('M-PESA callback amount mismatch:', checkoutId);
        const state = await markReviewIfCurrent(inboxRef, expectedCallback);
        return {
          state: state === 'REVIEW' ? 'AMOUNT_MISMATCH' : state
        };
      }
    }

    const result = await db.runTransaction(async firestoreTx => {
      // Read both documents before making any writes. Firestore retries this
      // transaction if the callback inbox changes while processing is underway.
      const currentInboxSnap = await firestoreTx.get(inboxRef);

      if (!currentInboxSnap.exists) {
        return { state: 'NO_CALLBACK' };
      }

      const currentInbox = currentInboxSnap.data();

      if (currentInbox.status !== 'RECEIVED') {
        return { state: currentInbox.status || 'UNKNOWN' };
      }

      if (!sameCallback(currentInbox, expectedCallback)) {
        return { state: 'CONFLICT' };
      }

      const snap = await firestoreTx.get(ref);
      const existing = snap.exists ? snap.data() : null;

      if (!existing) return { state: 'NOT_READY' };

      const currentStatus = String(existing.status || '').toUpperCase();

      if (currentStatus === 'PAID' || currentStatus === 'FAILED') {
        firestoreTx.set(inboxRef, {
          status: 'PROCESSED',
          processedAt: serverTimestamp()
        }, { merge: true });

        return {
          state: 'PROCESSED',
          terminal: true,
          failed: currentStatus === 'FAILED'
        };
      }

      if (currentStatus !== 'PENDING') {
        firestoreTx.set(inboxRef, {
          status: 'REVIEW',
          reviewDetectedAt: serverTimestamp()
        }, { merge: true });

        return { state: 'REVIEW' };
      }

      if (
        String(existing.paymentMethod || '') !== 'M-PESA' ||
        String(existing.merchantRequestId || '') !== String(attempt.merchantRequestId) ||
        String(existing.mpesaTimestamp || '') !== String(attempt.mpesaTimestamp)
      ) {
        firestoreTx.set(inboxRef, {
          status: 'REVIEW',
          reviewDetectedAt: serverTimestamp()
        }, { merge: true });

        return { state: 'REVIEW' };
      }

      if (verifiedResultCode === 0) {
        const expectedAmount = Number(existing.amount);

        if (
          !Number.isSafeInteger(expectedAmount) ||
          expectedAmount < 1 ||
          callbackAmountNumber !== expectedAmount
        ) {
          firestoreTx.set(inboxRef, {
            status: 'REVIEW',
            reviewDetectedAt: serverTimestamp()
          }, { merge: true });

          return { state: 'REVIEW' };
        }

        const updated = {
          ...existing,
          checkoutRequestId: checkoutId,
          amount: expectedAmount,
          callbackReceipt: receipt,
          receiptVerificationStatus: receipt
            ? 'PENDING_VERIFICATION'
            : 'MISSING',
          phone: existing.phone || '',
          paymentMethod: 'M-PESA',
          status: 'PAID',
          completedAt: serverTimestamp()
        };

        firestoreTx.set(ref, updated, { merge: true });

        if (existing.analyticsApplied === true) {
          if (typeof applyAnalyticsAggregates !== 'function') {
            throw new Error('Analytics updater missing for tracked transaction');
          }

          await applyAnalyticsAggregates(firestoreTx, {
            previous: existing,
            current: updated
          });
        }
      } else {
        const updated = {
          checkoutRequestId: checkoutId,
          paymentMethod: 'M-PESA',
          status: 'FAILED',
          failureCode: verifiedResultCode,
          failureDescription: String(
            queryData?.ResultDesc || 'M-PESA payment failed'
          ),
          completedAt: serverTimestamp()
        };

        firestoreTx.set(ref, updated, { merge: true });

        if (existing.analyticsApplied === true) {
          if (typeof applyAnalyticsAggregates !== 'function') {
            throw new Error('Analytics updater missing for tracked transaction');
          }

          await applyAnalyticsAggregates(firestoreTx, {
            previous: existing,
            current: { ...existing, ...updated }
          });
        }
      }

      // The payment transition and inbox completion commit atomically.
      firestoreTx.set(inboxRef, {
        status: 'PROCESSED',
        processedAt: serverTimestamp()
      }, { merge: true });

      return {
        state: verifiedResultCode === 0 ? 'PROCESSED' : 'FAILED',
        changed: true,
        failed: verifiedResultCode !== 0
      };
    });

    if (result.state === 'CONFLICT' || result.state === 'REVIEW') {
      console.log('M-PESA callback requires review:', checkoutId);
      return { state: result.state };
    }

    if (result.state === 'NOT_READY' || result.state === 'NO_CALLBACK') {
      return { state: result.state };
    }

    if (result.state === 'PROCESSED' || result.state === 'FAILED') {
      delete pendingTransactions[checkoutId];

      if (result.changed && result.failed) {
        console.log('M-PESA payment failed:', checkoutId, verifiedResultCode);
      } else if (result.changed) {
        console.log(
          'M-PESA payment successful; receipt pending verification:',
          checkoutId
        );
      }

      return { state: result.state };
    }

    return { state: result.state || 'NOT_READY' };
  }

  return processMpesaCallback;
}

module.exports = { createMpesaCallbackProcessor };
