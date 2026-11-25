const crypto = require('node:crypto');

function createMpesaPaymentIntents({ db, FieldValue }) {
  async function reserveMpesaIntent({
    uid,
    idempotencyKey,
    phone,
    amount,
    plate,
    revenueType,
    revenueSubType
  }) {
    const intentId = crypto.createHash('sha256')
      .update(`${uid}:mpesa:${idempotencyKey}`)
      .digest('hex');

    const ref = db.collection('payment_intents').doc(intentId);

    const requestData = {
      createdBy: uid,
      phone,
      amount,
      plate,
      revenueType,
      revenueSubType
    };

    return db.runTransaction(async transaction => {
      const snap = await transaction.get(ref);

      if (snap.exists) {
        const saved = snap.data();

        const sameRequest =
          saved.createdBy === uid &&
          saved.phone === phone &&
          saved.amount === amount &&
          saved.plate === plate &&
          saved.revenueType === revenueType &&
          saved.revenueSubType === revenueSubType;

        if (!sameRequest) {
          const conflict = new Error(
            'This payment identifier belongs to a different request.'
          );
          conflict.statusCode = 409;
          throw conflict;
        }

        return {
          created: false,
          ref,
          intent: saved
        };
      }

      const intent = {
        ...requestData,
        status: 'RESERVED',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      transaction.create(ref, intent);

      return {
        created: true,
        ref,
        intent
      };
    });
  }

  async function claimMpesaSubmission(ref, attemptDetails = {}) {
    return db.runTransaction(async transaction => {
      const snap = await transaction.get(ref);

      if (!snap.exists) {
        return { claimed: false, state: 'NOT_FOUND' };
      }

      const intent = snap.data();
      const state = String(intent.status || '').toUpperCase();

      if (state !== 'RESERVED') {
        return {
          claimed: false,
          state,
          checkoutId: intent.checkoutRequestId || null
        };
      }

      const attemptNumber = (Number.isSafeInteger(intent.attemptCount)
        ? intent.attemptCount
        : 0) + 1;

      const attemptId = crypto.createHash('sha256')
        .update(`${ref.id}:attempt:${attemptNumber}`)
        .digest('hex');

      const attemptRef = db.collection('payment_attempts').doc(attemptId);
      const attemptSnap = await transaction.get(attemptRef);

      if (attemptSnap.exists) {
        throw new Error('Payment attempt identifier already exists.');
      }

      const startedAt = FieldValue.serverTimestamp();

      const attempt = {
        intentId: ref.id,
        attemptNumber,
        officerUid: intent.createdBy,
        idempotencyKey: attemptDetails.idempotencyKey || null,
        phone: intent.phone,
        amount: intent.amount,
        plate: intent.plate,
        accountReference: attemptDetails.accountReference || null,
        revenueType: intent.revenueType,
        revenueSubType: intent.revenueSubType,
        darajaTimestamp: attemptDetails.mpesaTimestamp || null,
        status: 'SUBMITTING',
        checkoutRequestId: null,
        merchantRequestId: null,
        errorCode: null,
        submissionStartedAt: startedAt,
        createdAt: startedAt,
        updatedAt: startedAt
      };

      transaction.create(attemptRef, attempt);

      transaction.update(ref, {
        status: 'SUBMITTING',
        attemptCount: attemptNumber,
        activeAttemptId: attemptId,
        submissionStartedAt: startedAt,
        updatedAt: startedAt
      });

      return {
        claimed: true,
        state: 'SUBMITTING',
        attemptId,
        attemptRef,
        attemptNumber
      };
    });
  }

  return {
    reserveMpesaIntent,
    claimMpesaSubmission
  };
}

module.exports = { createMpesaPaymentIntents };
