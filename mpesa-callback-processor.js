function createMpesaCallbackProcessor({
  db,
  applyAnalyticsAggregates,
  queryMpesaStk,
  pendingTransactions,
  serverTimestamp
}) {
  if (!db || typeof queryMpesaStk !== 'function' ||
      !pendingTransactions || typeof serverTimestamp !== 'function') {
    throw new Error('Missing M-PESA callback processor dependency');
  }

  async function processMpesaCallback(checkoutId) {
  const inboxRef = db.collection('mpesa_callback_inbox').doc(checkoutId);
  const inboxSnap = await inboxRef.get();

  if (!inboxSnap.exists) return { state: 'NO_CALLBACK' };

  const inbox = inboxSnap.data();

  if (inbox.status === 'PROCESSED') {
    return { state: 'PROCESSED', duplicate: true };
  }

  if (
    inbox.status === 'CONFLICT' ||
    inbox.status === 'REVIEW'
  ) {
    return { state: inbox.status };
  }

  const callbackMerchantId = String(inbox.merchantRequestId || '');
  const resultCode = inbox.resultCode;
  const callbackAmount = inbox.amount;
  const receipt = String(inbox.receipt || '');

  if (!Number.isSafeInteger(resultCode) || resultCode < 0) {
    await inboxRef.update({ status: 'REVIEW' });
    return { state: 'INVALID_CALLBACK' };
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
    await inboxRef.update({ status: 'REVIEW' });
    return { state: 'VERIFICATION_MISMATCH' };
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
      await inboxRef.update({ status: 'REVIEW' });
      return { state: 'AMOUNT_MISMATCH' };
    }
  }

  const result = await db.runTransaction(async firestoreTx => {
    const snap = await firestoreTx.get(ref);
    const existing = snap.exists ? snap.data() : null;

    if (!existing) return { found: false, changed: false };

    const currentStatus = String(existing.status || '').toUpperCase();

    if (currentStatus === 'PAID' || currentStatus === 'FAILED') {
      return { found: true, changed: false, terminal: true };
    }

    if (currentStatus !== 'PENDING') {
      return { found: true, changed: false, invalidState: true };
    }

    if (
      String(existing.paymentMethod || '') !== 'M-PESA' ||
      String(existing.merchantRequestId || '') !== String(attempt.merchantRequestId) ||
      String(existing.mpesaTimestamp || '') !== String(attempt.mpesaTimestamp)
    ) {
      return { found: true, changed: false, invalidIdentifiers: true };
    }

    if (verifiedResultCode === 0) {
      const expectedAmount = Number(existing.amount);

      if (
        !Number.isSafeInteger(expectedAmount) ||
        expectedAmount < 1 ||
        callbackAmountNumber !== expectedAmount
      ) {
        return { found: true, changed: false, invalidSuccess: true };
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

      return { found: true, changed: true };
    }

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

    return { found: true, changed: true, failed: true };
  });

  if (result.found && (result.changed || result.terminal)) {
    await inboxRef.update({
      status: 'PROCESSED',
      processedAt: serverTimestamp()
    });
    delete pendingTransactions[checkoutId];

    if (result.changed && result.failed) {
      console.log('M-PESA payment failed:', checkoutId, verifiedResultCode);
    } else if (result.changed) {
      console.log(
        'M-PESA payment successful; receipt pending verification:',
        checkoutId
      );
    }
    return { state: result.failed ? 'FAILED' : 'PROCESSED' };
  }

  if (result.invalidSuccess || result.invalidIdentifiers || result.invalidState) {
    await inboxRef.update({ status: 'REVIEW' });
    console.log('M-PESA callback requires review:', checkoutId);
    return { state: 'REVIEW' };
  }

  return { state: 'NOT_READY' };
}

  return processMpesaCallback;
}

module.exports = { createMpesaCallbackProcessor };
