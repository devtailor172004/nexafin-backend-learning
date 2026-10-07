import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PAYMENT_STATUS,
    PAYMENT_EVENT,
    canTransition,
    allowedTransitions,
    isTerminalStatus,
    mapProviderEventToInternal,
    statusForEvent
} from '../src/securepay/stateMachine.js';

test('allows the documented happy path', () => {
    assert.equal(canTransition('CREATED', 'PENDING'), true);
    assert.equal(canTransition('PENDING', 'AUTHORIZED'), true);
    assert.equal(canTransition('AUTHORIZED', 'PROCESSED'), true);
    assert.equal(canTransition('PROCESSED', 'REFUND_PENDING'), true);
    assert.equal(canTransition('REFUND_PENDING', 'REFUNDED'), true);
});

test('allows the documented failure paths', () => {
    assert.equal(canTransition('PENDING', 'FAILED'), true);
    assert.equal(canTransition('PENDING', 'EXPIRED'), true);
    assert.equal(canTransition('AUTHORIZED', 'CANCELLED'), true);
    assert.equal(canTransition('REFUND_PENDING', 'REFUND_FAILED'), true);
});

test('refuses illegal regressions', () => {
    // These are the cases the prompt calls out explicitly.
    assert.equal(canTransition('FAILED', 'PROCESSED'), false);
    assert.equal(canTransition('PROCESSED', 'PENDING'), false);
    assert.equal(canTransition('AUTHORIZED', 'PENDING'), false);
    assert.equal(canTransition('CANCELLED', 'PROCESSED'), false);
    assert.equal(canTransition('REFUNDED', 'PROCESSED'), false);
    assert.equal(canTransition('EXPIRED', 'PENDING'), false);
});

test('same-status re-delivery is a no-op, not a regression', () => {
    assert.equal(canTransition('AUTHORIZED', 'AUTHORIZED'), true);
    assert.equal(canTransition('PROCESSED', 'PROCESSED'), true);
});

test('unknown source status cannot reach a settled state', () => {
    assert.equal(canTransition('NOT_A_STATUS', 'PROCESSED'), false);
    // A brand new record with no status may be initialized.
    assert.equal(canTransition(null, 'PENDING'), true);
    assert.equal(canTransition(undefined, 'AUTHORIZED'), true);
});

test('terminal statuses are terminal', () => {
    ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].forEach((status) => {
        assert.equal(isTerminalStatus(status), true);
        assert.deepEqual(allowedTransitions(status), []);
    });
    assert.equal(isTerminalStatus('PENDING'), false);
});

test('maps provider events to internal events', () => {
    assert.equal(mapProviderEventToInternal('ORDER_AUTHORIZED'), PAYMENT_EVENT.PAYMENT_AUTHORIZED);
    assert.equal(mapProviderEventToInternal('ORDER_PROCESSED'), PAYMENT_EVENT.PAYMENT_PROCESSED);
    assert.equal(mapProviderEventToInternal('order_success'), PAYMENT_EVENT.PAYMENT_PROCESSED);
    assert.equal(mapProviderEventToInternal('ORDER_FAILED'), PAYMENT_EVENT.PAYMENT_FAILED);
    assert.equal(mapProviderEventToInternal('ORDER_CANCELLED'), PAYMENT_EVENT.PAYMENT_CANCELLED);
    assert.equal(mapProviderEventToInternal('ORDER_EXPIRED'), PAYMENT_EVENT.PAYMENT_EXPIRED);
    assert.equal(mapProviderEventToInternal('ORDER_CREATED'), PAYMENT_EVENT.PAYMENT_CREATED);
});

test('refund and payout events are mapped before payment keywords', () => {
    assert.equal(mapProviderEventToInternal('REFUND_SUCCESS'), PAYMENT_EVENT.REFUND_SUCCESS);
    assert.equal(mapProviderEventToInternal('REFUND_FAILED'), PAYMENT_EVENT.REFUND_FAILED);
    assert.equal(mapProviderEventToInternal('REFUND_INITIATED'), PAYMENT_EVENT.REFUND_PENDING);
    assert.equal(mapProviderEventToInternal('PAYOUT_PROCESSED'), PAYMENT_EVENT.PAYOUT_SUCCESS);
    assert.equal(mapProviderEventToInternal('PAYOUT_FAILED'), PAYMENT_EVENT.PAYOUT_FAILED);
});

test('AUTHORIZED is not mistaken for a settlement event', () => {
    // 'AUTHORIZED' is in the success keyword list used by normalize helpers,
    // but authorization must map to AUTHORIZED, never PROCESSED.
    assert.equal(mapProviderEventToInternal('PAYMENT_AUTHORIZED'), PAYMENT_EVENT.PAYMENT_AUTHORIZED);
    assert.notEqual(statusForEvent(mapProviderEventToInternal('PAYMENT_AUTHORIZED')), PAYMENT_STATUS.PROCESSED);
});

test('unknown provider event falls back to PENDING', () => {
    assert.equal(mapProviderEventToInternal('SOMETHING_ELSE'), PAYMENT_EVENT.PAYMENT_PENDING);
    assert.equal(mapProviderEventToInternal(''), PAYMENT_EVENT.PAYMENT_PENDING);
    assert.equal(mapProviderEventToInternal(undefined), PAYMENT_EVENT.PAYMENT_PENDING);
});

test('payout events do not move payment state', () => {
    assert.equal(statusForEvent(PAYMENT_EVENT.PAYOUT_PENDING), null);
    assert.equal(statusForEvent(PAYMENT_EVENT.PAYOUT_SUCCESS), null);
    assert.equal(statusForEvent(PAYMENT_EVENT.PAYOUT_FAILED), null);
});
