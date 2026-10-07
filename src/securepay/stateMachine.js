/**
 * Payment state machine + provider event mapper.
 *
 * This module is intentionally PURE (no database, no HTTP) so it can be unit
 * tested in isolation and reused by webhooks, callbacks, polling and admin
 * tooling.
 *
 * Design rules:
 *   - No API may arbitrarily move a payment backwards (FAILED -> PROCESSED).
 *   - Every transition must exist in PAYMENT_TRANSITIONS.
 *   - Re-entering the same state is a no-op (providers re-send events).
 */

export const PAYMENT_STATUS = Object.freeze({
    CREATED: 'CREATED',
    PENDING: 'PENDING',
    AUTHORIZED: 'AUTHORIZED',
    PROCESSED: 'PROCESSED',
    FAILED: 'FAILED',
    EXPIRED: 'EXPIRED',
    CANCELLED: 'CANCELLED',
    REFUND_PENDING: 'REFUND_PENDING',
    REFUNDED: 'REFUNDED',
    REFUND_FAILED: 'REFUND_FAILED'
});

export const PAYMENT_TRANSITIONS = Object.freeze({
    CREATED: ['PENDING', 'AUTHORIZED', 'PROCESSED', 'FAILED', 'CANCELLED', 'EXPIRED'],
    PENDING: ['AUTHORIZED', 'PROCESSED', 'FAILED', 'EXPIRED', 'CANCELLED'],
    AUTHORIZED: ['PROCESSED', 'CANCELLED', 'FAILED', 'REFUND_PENDING'],
    PROCESSED: ['REFUND_PENDING'],
    REFUND_PENDING: ['REFUNDED', 'REFUND_FAILED'],
    REFUND_FAILED: ['REFUND_PENDING'],
    REFUNDED: [],
    FAILED: [],
    CANCELLED: [],
    EXPIRED: []
});

export const TERMINAL_STATUSES = Object.freeze(['REFUNDED', 'FAILED', 'CANCELLED', 'EXPIRED']);

/**
 * Internal event catalog. Provider events are normalized into these before
 * touching business state.
 */
export const PAYMENT_EVENT = Object.freeze({
    PAYMENT_CREATED: 'PAYMENT_CREATED',
    PAYMENT_PENDING: 'PAYMENT_PENDING',
    PAYMENT_AUTHORIZED: 'PAYMENT_AUTHORIZED',
    PAYMENT_PROCESSED: 'PAYMENT_PROCESSED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    PAYMENT_CANCELLED: 'PAYMENT_CANCELLED',
    PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
    REFUND_PENDING: 'REFUND_PENDING',
    REFUND_SUCCESS: 'REFUND_SUCCESS',
    REFUND_FAILED: 'REFUND_FAILED',
    PAYOUT_PENDING: 'PAYOUT_PENDING',
    PAYOUT_SUCCESS: 'PAYOUT_SUCCESS',
    PAYOUT_FAILED: 'PAYOUT_FAILED',
    TRANSITION_REJECTED: 'TRANSITION_REJECTED'
});

/**
 * Internal event -> resulting payment status.
 * Events that do not move payment state (payouts) map to null.
 */
export const EVENT_TO_STATUS = Object.freeze({
    [PAYMENT_EVENT.PAYMENT_CREATED]: PAYMENT_STATUS.PENDING,
    [PAYMENT_EVENT.PAYMENT_PENDING]: PAYMENT_STATUS.PENDING,
    [PAYMENT_EVENT.PAYMENT_AUTHORIZED]: PAYMENT_STATUS.AUTHORIZED,
    [PAYMENT_EVENT.PAYMENT_PROCESSED]: PAYMENT_STATUS.PROCESSED,
    [PAYMENT_EVENT.PAYMENT_FAILED]: PAYMENT_STATUS.FAILED,
    [PAYMENT_EVENT.PAYMENT_CANCELLED]: PAYMENT_STATUS.CANCELLED,
    [PAYMENT_EVENT.PAYMENT_EXPIRED]: PAYMENT_STATUS.EXPIRED,
    [PAYMENT_EVENT.REFUND_PENDING]: PAYMENT_STATUS.REFUND_PENDING,
    [PAYMENT_EVENT.REFUND_SUCCESS]: PAYMENT_STATUS.REFUNDED,
    [PAYMENT_EVENT.REFUND_FAILED]: PAYMENT_STATUS.REFUND_FAILED,
    [PAYMENT_EVENT.PAYOUT_PENDING]: null,
    [PAYMENT_EVENT.PAYOUT_SUCCESS]: null,
    [PAYMENT_EVENT.PAYOUT_FAILED]: null
});

const SUCCESS_KEYWORDS = ['SUCCESS', 'PROCESSED', 'CHARGED', 'CAPTURED', 'COMPLETED', 'AUTHORIZED'];
const FAILURE_KEYWORDS = ['FAIL', 'DECLINED', 'ERROR', 'REJECTED'];
const CANCEL_KEYWORDS = ['CANCEL', 'VOID'];
const EXPIRE_KEYWORDS = ['EXPIRE', 'TIMEOUT'];
const PENDING_KEYWORDS = ['PENDING', 'PROCESSING', 'INITIATED', 'CREATED'];

const includesAny = (haystack, needles) => needles.some((n) => haystack.includes(n));

/**
 * Maps a raw provider event type (e.g. "ORDER_AUTHORIZED") to an internal
 * catalog event. Works across order/payment/refund/payout naming variants.
 *
 * @param {string} providerEventType
 * @returns {string} internal event (defaults to PAYMENT_PENDING)
 */
export const mapProviderEventToInternal = (providerEventType) => {
    const raw = String(providerEventType || '').trim().toUpperCase();
    if (!raw) return PAYMENT_EVENT.PAYMENT_PENDING;

    if (raw.includes('PAYOUT')) {
        if (includesAny(raw, FAILURE_KEYWORDS)) return PAYMENT_EVENT.PAYOUT_FAILED;
        if (includesAny(raw, SUCCESS_KEYWORDS)) return PAYMENT_EVENT.PAYOUT_SUCCESS;
        return PAYMENT_EVENT.PAYOUT_PENDING;
    }

    if (raw.includes('REFUND')) {
        if (includesAny(raw, FAILURE_KEYWORDS)) return PAYMENT_EVENT.REFUND_FAILED;
        if (includesAny(raw, SUCCESS_KEYWORDS)) return PAYMENT_EVENT.REFUND_SUCCESS;
        return PAYMENT_EVENT.REFUND_PENDING;
    }

    if (includesAny(raw, FAILURE_KEYWORDS)) return PAYMENT_EVENT.PAYMENT_FAILED;
    if (includesAny(raw, CANCEL_KEYWORDS)) return PAYMENT_EVENT.PAYMENT_CANCELLED;
    if (includesAny(raw, EXPIRE_KEYWORDS)) return PAYMENT_EVENT.PAYMENT_EXPIRED;

    // AUTHORIZED must be checked before the generic success keywords, because
    // SUCCESS_KEYWORDS also contains AUTHORIZED but authorization is not a
    // settlement event.
    if (raw.includes('AUTHORIZED') || raw.includes('AUTHORISED')) {
        return PAYMENT_EVENT.PAYMENT_AUTHORIZED;
    }
    if (raw.includes('PROCESSED') || raw.includes('CAPTURED') || raw.includes('CHARGED') || raw.includes('SUCCESS')) {
        return PAYMENT_EVENT.PAYMENT_PROCESSED;
    }
    if (raw.includes('CREATED')) return PAYMENT_EVENT.PAYMENT_CREATED;
    if (includesAny(raw, PENDING_KEYWORDS)) return PAYMENT_EVENT.PAYMENT_PENDING;

    return PAYMENT_EVENT.PAYMENT_PENDING;
};

/**
 * Resolves the target status for an internal event.
 * @returns {string|null}
 */
export const statusForEvent = (internalEvent) => {
    if (!internalEvent) return null;
    return EVENT_TO_STATUS[internalEvent] ?? null;
};

export const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);

/**
 * True when moving from `from` to `to` is allowed.
 * A missing `from` (unknown/new record) or an identical status is allowed.
 */
export const canTransition = (from, to) => {
    if (!to) return false;
    if (!from) return true;
    const normalizedFrom = String(from).toUpperCase();
    const normalizedTo = String(to).toUpperCase();
    if (normalizedFrom === normalizedTo) return true;
    const allowed = PAYMENT_TRANSITIONS[normalizedFrom];
    if (!allowed) return false;
    return allowed.includes(normalizedTo);
};

/**
 * Lists the statuses reachable from `from`.
 */
export const allowedTransitions = (from) => {
    if (!from) return [];
    return [...(PAYMENT_TRANSITIONS[String(from).toUpperCase()] || [])];
};
