import { findEligibleProviders, getProvider, listProviders } from './providerRegistry.js';
import { getProviderLatency } from './providerMetrics.js';
import { PAYMENT_STATUS } from './stateMachine.js';

/**
 * Smart Provider Routing.
 *
 * Two responsibilities, deliberately separated:
 *
 *   1. `selectProvider`      — pick the best ELIGIBLE provider for a
 *                              (method, currency, country) requirement.
 *   2. `evaluateFailover`    — decide whether moving an existing payment to
 *                              another provider is SAFE.
 *
 * The second is the important one. The rule from the brief: never fail over
 * blindly after a payment attempt. If a provider call already happened and its
 * outcome is not yet known, the correct action is to check the payment status
 * first — not to fire the same charge at a second provider.
 */

/** Statuses that mean "we do not know the outcome yet". */
export const OUTCOME_UNKNOWN_STATUSES = Object.freeze([
    PAYMENT_STATUS.CREATED,
    PAYMENT_STATUS.PENDING,
    PAYMENT_STATUS.AUTHORIZED
]);

/** Statuses where the payment is finished and must not be re-routed. */
export const SETTLED_STATUSES = Object.freeze([
    PAYMENT_STATUS.PROCESSED,
    PAYMENT_STATUS.REFUND_PENDING,
    PAYMENT_STATUS.REFUNDED
]);

/** Statuses where a retry (possibly on another provider) is legitimate. */
export const RETRYABLE_STATUSES = Object.freeze([
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.CANCELLED,
    PAYMENT_STATUS.EXPIRED
]);

const HEALTH_RANK = Object.freeze({
    HEALTHY: 4,
    NO_TRAFFIC: 3,
    DEGRADED: 2,
    UNHEALTHY: 1,
    NOT_INTEGRATED: 0
});

/**
 * Classifies health from a success rate.
 * Returns NO_TRAFFIC (never HEALTHY) when there is no data.
 */
export const classifyHealth = ({ successRate, transactions }) => {
    if (!transactions) return 'NO_TRAFFIC';
    if (successRate >= 95) return 'HEALTHY';
    if (successRate >= 80) return 'DEGRADED';
    return 'UNHEALTHY';
};

/**
 * Selects a provider for a payment requirement.
 *
 * @param {object} requirement
 * @param {string} [requirement.method]   e.g. 'UPI'
 * @param {string} [requirement.currency] e.g. 'INR'
 * @param {string} [requirement.country]  ISO country code, e.g. 'IN'
 * @param {object} [requirement.healthByProvider] optional live success rates
 * @returns {{selected: object|null, candidates: object[], reason: string}}
 */
export const selectProvider = (requirement = {}) => {
    const { method, currency, country, healthByProvider = {} } = requirement;

    const eligible = findEligibleProviders({ method, currency, country });

    if (!eligible.length) {
        return {
            selected: null,
            candidates: [],
            reason: 'NO_ELIGIBLE_PROVIDER',
            requirement: { method: method || null, currency: currency || null, country: country || null }
        };
    }

    const ranked = eligible
        .map((provider) => {
            const reported = healthByProvider[provider.code] || {};
            const health = classifyHealth({
                successRate: reported.successRate ?? 0,
                transactions: reported.transactions ?? 0
            });
            const latency = getProviderLatency(provider.code);

            return {
                code: provider.code,
                displayName: provider.displayName,
                health,
                successRate: reported.successRate ?? 0,
                transactions: reported.transactions ?? 0,
                latency,
                methods: provider.methods,
                currencies: provider.currencies,
                countries: provider.countries,
                // Higher is better. Latency is a tie-breaker only.
                score: HEALTH_RANK[health] ?? 0
            };
        })
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const aLatency = a.latency?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
            const bLatency = b.latency?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
            return aLatency - bLatency;
        });

    return {
        selected: ranked[0],
        candidates: ranked,
        reason: 'OK',
        requirement: { method: method || null, currency: currency || null, country: country || null }
    };
};

export const isOutcomeUnknown = (payment) => (
    OUTCOME_UNKNOWN_STATUSES.includes(payment?.status)
);

export const isSettled = (payment) => SETTLED_STATUSES.includes(payment?.status);

/**
 * True when a provider call was already attempted for this payment.
 */
export const hasProviderAttempt = (payment) => Boolean(
    payment && (payment.nxPayPaymentId || payment.merchantPaymentReference || payment.challengeUrl)
);

/**
 * Decides whether failing a payment over to another provider is safe.
 *
 * @param {object} params
 * @param {object} params.payment            PineLabsPayment instance (or plain object)
 * @param {boolean} [params.webhookReceived] whether a terminal webhook has been seen
 * @returns {{allowed:boolean, reason:string, recommendedAction:string, currentStatus:string|null}}
 */
export const evaluateFailover = ({ payment, webhookReceived = false } = {}) => {
    const currentStatus = payment?.status ?? null;

    if (!payment) {
        return {
            allowed: true,
            reason: 'NO_PRIOR_ATTEMPT',
            recommendedAction: 'PROCEED',
            currentStatus: null
        };
    }

    if (isSettled(payment)) {
        return {
            allowed: false,
            reason: 'ALREADY_SETTLED',
            recommendedAction: 'NONE',
            currentStatus
        };
    }

    if (RETRYABLE_STATUSES.includes(currentStatus)) {
        return {
            allowed: true,
            reason: 'TERMINAL_FAILURE',
            recommendedAction: 'RETRY_WITH_ROUTER',
            currentStatus
        };
    }

    if (isOutcomeUnknown(payment) && hasProviderAttempt(payment) && !webhookReceived) {
        return {
            allowed: false,
            reason: 'OUTCOME_UNKNOWN',
            recommendedAction: 'CHECK_PAYMENT_STATUS_FIRST',
            currentStatus
        };
    }

    if (isOutcomeUnknown(payment)) {
        return {
            allowed: false,
            reason: 'PAYMENT_IN_PROGRESS',
            recommendedAction: 'WAIT_OR_POLL',
            currentStatus
        };
    }

    return {
        allowed: false,
        reason: 'UNHANDLED_STATUS',
        recommendedAction: 'REVIEW_MANUALLY',
        currentStatus
    };
};

/** Describes what the router knows, for the admin UI. */
export const describeRegistry = () => listProviders().map((provider) => ({
    ...provider,
    latency: getProviderLatency(provider.code)
}));

export { getProvider };
