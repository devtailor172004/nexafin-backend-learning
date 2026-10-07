import PaymentEvent from '../models/PaymentEvent.js';
import PineLabsPayment from '../models/PineLabsPayment.js';
import {
    canTransition,
    statusForEvent,
    mapProviderEventToInternal,
    allowedTransitions,
    isTerminalStatus,
    PAYMENT_EVENT
} from './stateMachine.js';
import { publishLiveEvent } from './eventBus.js';
import logger from '../utils/logger.js';

/**
 * Payment event engine.
 *
 * Responsibilities:
 *   1. Record timeline events (append-only).
 *   2. Apply provider events through the state machine (never regress state).
 *   3. Publish live events for the real-time operations dashboard.
 */

/**
 * Appends a timeline row and publishes a live event.
 * Never throws on publish failures.
 */
export const recordPaymentEvent = async ({
    orderId = null,
    paymentId = null,
    eventType,
    providerEventType = null,
    source = 'SYSTEM',
    statusFrom = null,
    statusTo = null,
    message = null,
    isRejected = false,
    actorId = null,
    provider = 'PINELABS',
    providerEventId = null,
    metadata = null,
    transaction = null
}) => {
    const created = await PaymentEvent.create({
        orderId,
        paymentId,
        eventType,
        providerEventType,
        source,
        statusFrom,
        statusTo,
        message,
        isRejected,
        actorId,
        provider,
        providerEventId,
        metadata
    }, { transaction });

    publishLiveEvent({
        kind: 'payment.event',
        eventType,
        providerEventType,
        paymentId,
        orderId,
        statusFrom,
        statusTo,
        message,
        isRejected,
        source,
        provider
    });

    return created;
};

/**
 * Applies a status transition to a payment model instance using the state
 * machine. Rejected transitions are recorded on the timeline as
 * TRANSITION_REJECTED and never mutate the payment.
 *
 * @param {object} params
 * @param {object} params.payment     - PineLabsPayment instance
 * @param {string} params.internalEvent
 * @param {string} [params.source]
 * @param {string} [params.providerEventType]
 * @param {string} [params.providerEventId]
 * @param {string} [params.message]
 * @param {object} [params.metadata]
 * @param {object} [params.transaction]
 * @returns {Promise<{applied:boolean, from:string|null, to:string|null}>}
 */
export const applyInternalEvent = async ({
    payment,
    internalEvent,
    source = 'WEBHOOK',
    providerEventType = null,
    providerEventId = null,
    message = null,
    metadata = null,
    transaction = null
}) => {
    const targetStatus = statusForEvent(internalEvent);

    // Events that do not move payment state (e.g. payouts) are still recorded.
    if (!targetStatus) {
        await recordPaymentEvent({
            orderId: payment?.orderId ?? null,
            paymentId: payment?.id ?? null,
            eventType: internalEvent,
            providerEventType,
            source,
            statusFrom: payment?.status ?? null,
            statusTo: payment?.status ?? null,
            message: message || `${internalEvent} recorded (no payment state change)`,
            providerEventId,
            metadata,
            transaction
        });
        return { applied: false, from: payment?.status ?? null, to: payment?.status ?? null };
    }

    const from = payment?.status ?? null;

    if (!canTransition(from, targetStatus)) {
        const reason = `Illegal payment transition ${from} -> ${targetStatus} for event ${internalEvent}. Allowed: ${allowedTransitions(from).join(', ') || 'none'}`;
        logger.warn(reason);

        await recordPaymentEvent({
            orderId: payment?.orderId ?? null,
            paymentId: payment?.id ?? null,
            eventType: PAYMENT_EVENT.TRANSITION_REJECTED,
            providerEventType,
            source,
            statusFrom: from,
            statusTo: targetStatus,
            message: reason,
            isRejected: true,
            providerEventId,
            metadata,
            transaction
        });

        return { applied: false, from, to: from };
    }

    if (payment && from !== targetStatus) {
        payment.status = targetStatus;
        await payment.save({ transaction });
    }

    await recordPaymentEvent({
        orderId: payment?.orderId ?? null,
        paymentId: payment?.id ?? null,
        eventType: internalEvent,
        providerEventType,
        source,
        statusFrom: from,
        statusTo: targetStatus,
        message,
        providerEventId,
        metadata,
        transaction
    });

    return { applied: from !== targetStatus, from, to: targetStatus };
};

const TECHNICAL_FAILURE_PATTERNS = [
    'TIMEOUT',
    'TIME_OUT',
    'NETWORK',
    'SYSTEM',
    'UNAVAILABLE',
    'GATEWAY',
    'CONNECTION',
    'INTERNAL',
    'TRY_AGAIN',
    'TEMPORARY'
];

/**
 * True when a failure looks transient (safe to retry) rather than a business
 * decline (do not retry).
 */
export const isTechnicalFailure = (errorCode, errorMessage) => {
    const haystack = `${errorCode || ''} ${errorMessage || ''}`.toUpperCase();
    if (!haystack.trim()) return false;
    return TECHNICAL_FAILURE_PATTERNS.some((pattern) => haystack.includes(pattern));
};

/**
 * Builds the "why did this payment fail?" explanation from stored state and
 * timeline. Pure read-side helper.
 */
export const buildPaymentExplanation = ({ payment, order, events = [] }) => {
    const timeline = events.map((e) => ({
        at: e.createdAt,
        event: e.eventType,
        providerEvent: e.providerEventType,
        from: e.statusFrom,
        to: e.statusTo,
        source: e.source,
        message: e.message,
        rejected: e.isRejected
    }));

    const status = payment?.status || order?.pluralStatus || 'UNKNOWN';

    const knownStages = [
        { match: 'ORDER_CREATED', stage: 'Order creation' },
        { match: 'PROVIDER_ORDER_CREATED', stage: 'Provider order creation' },
        { match: 'PAYMENT_INITIATED', stage: 'Payment initiation' },
        { match: 'PAYMENT_AUTHORIZED', stage: 'Provider authorization' },
        { match: 'PAYMENT_PROCESSED', stage: 'Payment capture' },
        { match: 'PAYMENT_FAILED', stage: 'Provider authorization' },
        { match: 'PAYMENT_CANCELLED', stage: 'Payment cancellation' },
        { match: 'PAYMENT_EXPIRED', stage: 'Payment expiry' }
    ];

    const lastEvent = events.length ? events[events.length - 1] : null;
    const stageEntry = knownStages.find((s) => s.match === lastEvent?.eventType);
    const webhookReceived = events.some((e) => e.source === 'WEBHOOK');
    const isFailed = ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_FAILED'].includes(status);

    return {
        paymentId: payment?.uuid || null,
        orderId: order?.uuid || null,
        status,
        failed: isFailed,
        stage: stageEntry?.stage || (lastEvent?.eventType || 'UNKNOWN'),
        provider: 'PINELABS',
        errorCode: payment?.errorCode || null,
        errorMessage: payment?.errorMessage || lastEvent?.message || null,
        // A technical failure (timeout / network / provider outage) is worth a
        // retry; a business decline (bank declined, invalid card) is not.
        retryRecommended: isFailed && isTechnicalFailure(payment?.errorCode, payment?.errorMessage),
        webhookReceived,
        reconciliation: 'PENDING',
        timeline
    };
};
