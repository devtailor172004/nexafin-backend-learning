import { publishLiveEvent } from './eventBus.js';

/**
 * Namespaced security events.
 *
 * These ride on the existing live event bus (and therefore the existing SSE
 * stream) but are tagged with `namespace: 'security'` and a `securityType`, so
 * the operations dashboard keeps working unchanged while the Security Center can
 * filter for its own events.
 */

export const SECURITY_NAMESPACE = 'security';

export const SECURITY_EVENT = {
    RISK_EVALUATED: 'risk.evaluated',
    RISK_HOLD: 'risk.hold',
    RISK_BLOCKED: 'risk.blocked',
    ACCOUNT_FROZEN: 'account.frozen',
    ACCOUNT_UNFROZEN: 'account.unfrozen',
    INCIDENT_OPENED: 'incident.opened',
    INCIDENT_CLOSED: 'incident.closed',
    REVIEW_RECORDED: 'review.recorded',
    WEBHOOK_REJECTED: 'webhook.rejected',
    ACCESS_DENIED: 'access.denied',
    AUTH_EVENT: 'auth.event',
    LEDGER_POSTED: 'ledger.posted',
    SCENARIO_COMPLETED: 'scenario.completed'
};

/**
 * Publishes a security event. Never throws — observability must not break a
 * money-moving flow.
 */
export const publishSecurityEvent = (type, payload = {}) => {
    return publishLiveEvent({
        ...payload,
        kind: `security.${type}`,
        namespace: SECURITY_NAMESPACE,
        securityType: type
    });
};

export default publishSecurityEvent;
