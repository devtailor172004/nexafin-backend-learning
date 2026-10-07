import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyHealth,
    selectProvider,
    evaluateFailover,
    isOutcomeUnknown,
    hasProviderAttempt
} from '../src/securepay/router.js';

test('health classification never claims HEALTHY without traffic', () => {
    assert.equal(classifyHealth({ successRate: 0, transactions: 0 }), 'NO_TRAFFIC');
    assert.equal(classifyHealth({ successRate: 99, transactions: 0 }), 'NO_TRAFFIC');
    assert.equal(classifyHealth({ successRate: 96, transactions: 10 }), 'HEALTHY');
    assert.equal(classifyHealth({ successRate: 85, transactions: 10 }), 'DEGRADED');
    assert.equal(classifyHealth({ successRate: 40, transactions: 10 }), 'UNHEALTHY');
});

test('router selects the only integrated provider for INR/UPI/IN', () => {
    const result = selectProvider({ method: 'UPI', currency: 'INR', country: 'IN' });

    assert.equal(result.reason, 'OK');
    assert.equal(result.selected.code, 'PINELABS');
    assert.equal(result.selected.methods.includes('UPI'), true);
});

test('router reports NO_ELIGIBLE_PROVIDER rather than guessing', () => {
    // No integrated provider supports USD + US.
    const result = selectProvider({ method: 'CARD', currency: 'USD', country: 'US' });

    assert.equal(result.reason, 'NO_ELIGIBLE_PROVIDER');
    assert.equal(result.selected, null);
    assert.deepEqual(result.candidates, []);
});

test('router refuses a method the provider does not support', () => {
    const result = selectProvider({ method: 'WALLET', currency: 'INR', country: 'IN' });
    assert.equal(result.selected, null);
    assert.equal(result.reason, 'NO_ELIGIBLE_PROVIDER');
});

test('a payment with no prior attempt may be routed', () => {
    const result = evaluateFailover({ payment: null });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'NO_PRIOR_ATTEMPT');
});

test('a settled payment must never be routed again', () => {
    const result = evaluateFailover({ payment: { status: 'PROCESSED', nxPayPaymentId: 'x' } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'ALREADY_SETTLED');
    assert.equal(result.recommendedAction, 'NONE');
});

test('a refunded payment must never be routed again', () => {
    const result = evaluateFailover({ payment: { status: 'REFUNDED', nxPayPaymentId: 'x' } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'ALREADY_SETTLED');
});

test('a terminally failed payment may be retried elsewhere', () => {
    ['FAILED', 'CANCELLED', 'EXPIRED'].forEach((status) => {
        const result = evaluateFailover({ payment: { status, nxPayPaymentId: 'x' } });
        assert.equal(result.allowed, true, `${status} should allow retry`);
        assert.equal(result.reason, 'TERMINAL_FAILURE');
    });
});

test('THE RULE: never fail over while the outcome is unknown', () => {
    const payment = { status: 'PENDING', nxPayPaymentId: 'pl_pay_1', merchantPaymentReference: 'REF_1' };

    const result = evaluateFailover({ payment, webhookReceived: false });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'OUTCOME_UNKNOWN');
    assert.equal(result.recommendedAction, 'CHECK_PAYMENT_STATUS_FIRST');
});

test('an in-progress payment waits even once a webhook arrived', () => {
    const payment = { status: 'AUTHORIZED', nxPayPaymentId: 'pl_pay_1' };
    const result = evaluateFailover({ payment, webhookReceived: true });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'PAYMENT_IN_PROGRESS');
    assert.equal(result.recommendedAction, 'WAIT_OR_POLL');
});

test('an in-progress payment with no provider attempt is still not failover-able', () => {
    const result = evaluateFailover({ payment: { status: 'CREATED' } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'PAYMENT_IN_PROGRESS');
});

test('outcome-unknown and attempt helpers agree with the policy', () => {
    assert.equal(isOutcomeUnknown({ status: 'PENDING' }), true);
    assert.equal(isOutcomeUnknown({ status: 'PROCESSED' }), false);
    assert.equal(hasProviderAttempt({ nxPayPaymentId: 'x' }), true);
    assert.equal(hasProviderAttempt({ merchantPaymentReference: 'ref' }), true);
    assert.equal(hasProviderAttempt({}), false);
});
