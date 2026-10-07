import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPaymentExplanation, isTechnicalFailure } from '../src/securepay/eventEngine.js';

const fakePayment = (overrides = {}) => ({
    uuid: 'pay-uuid',
    orderId: 1,
    status: 'FAILED',
    errorCode: 'BANK_DECLINED',
    errorMessage: 'Bank declined the transaction',
    ...overrides
});

const fakeOrder = () => ({ uuid: 'order-uuid', pluralStatus: 'FAILED' });

test('technical failures are marked retryable', () => {
    assert.equal(isTechnicalFailure('TIMEOUT', ''), true);
    assert.equal(isTechnicalFailure('', 'provider gateway unavailable'), true);
    assert.equal(isTechnicalFailure('NETWORK_ERROR', 'connection reset'), true);
});

test('business declines are not retryable', () => {
    assert.equal(isTechnicalFailure('BANK_DECLINED', 'insufficient funds'), false);
    assert.equal(isTechnicalFailure('INVALID_CARD', 'card expired'), false);
    assert.equal(isTechnicalFailure(null, null), false);
});

test('explanation surfaces stage, provider and timeline', () => {
    const events = [
        { createdAt: new Date('2026-01-01T10:00:00Z'), eventType: 'ORDER_CREATED', source: 'API', statusFrom: null, statusTo: 'CREATED' },
        { createdAt: new Date('2026-01-01T10:00:05Z'), eventType: 'WEBHOOK_RECEIVED', source: 'WEBHOOK', statusFrom: null, statusTo: 'FAILED' },
        { createdAt: new Date('2026-01-01T10:00:05Z'), eventType: 'PAYMENT_FAILED', source: 'WEBHOOK', statusFrom: 'PENDING', statusTo: 'FAILED', message: 'Bank declined' }
    ];

    const result = buildPaymentExplanation({
        payment: fakePayment(),
        order: fakeOrder(),
        events
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.failed, true);
    assert.equal(result.stage, 'Provider authorization');
    assert.equal(result.provider, 'PINELABS');
    assert.equal(result.errorCode, 'BANK_DECLINED');
    assert.equal(result.webhookReceived, true);
    assert.equal(result.retryRecommended, false);
    assert.equal(result.timeline.length, 3);
    assert.equal(result.timeline[2].event, 'PAYMENT_FAILED');
});

test('explanation recommends retry for transient failures', () => {
    const result = buildPaymentExplanation({
        payment: fakePayment({ errorCode: 'GATEWAY_TIMEOUT', errorMessage: 'provider timed out' }),
        order: fakeOrder(),
        events: []
    });

    assert.equal(result.retryRecommended, true);
    assert.equal(result.stage, 'UNKNOWN');
});

test('explanation reports no failure for a processed payment', () => {
    const result = buildPaymentExplanation({
        payment: fakePayment({ status: 'PROCESSED', errorCode: null, errorMessage: null }),
        order: { uuid: 'order-uuid', pluralStatus: 'PROCESSED' },
        events: [{ createdAt: new Date(), eventType: 'PAYMENT_PROCESSED', source: 'WEBHOOK' }]
    });

    assert.equal(result.failed, false);
    assert.equal(result.retryRecommended, false);
});
