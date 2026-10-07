import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Loads the whole app module graph. This catches missing exports, typos in
 * import paths and broken middleware signatures — the classes of error that a
 * pure syntax check cannot see.
 *
 * It does NOT require a running database: Sequelize only opens a connection
 * when a query is executed.
 */
test('app module graph loads without throwing', async () => {
    const module = await import('../src/app.js');
    assert.equal(typeof module.default, 'function', 'app should export an express app');
});

test('SecurePay ops router registers every documented route', async () => {
    const { default: router } = await import('../src/routes/SecurePay/ops.route.js');

    const paths = router.stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route.path);

    [
        '/dashboard',
        '/transactions/live',
        '/providers/health',
        '/payments/:uuid/timeline',
        '/payments/:uuid/explain',
        '/customers/:uuid/overview',
        '/stream'
    ].forEach((expected) => {
        assert.ok(paths.includes(expected), `expected route ${expected} to be registered, got: ${paths.join(', ')}`);
    });
});

test('webhook controller exposes both real and mock handlers', async () => {
    const webhook = await import('../src/controllers/Payment/PineLabs/Webhook/pineLabsWebhook.controller.js');
    assert.equal(typeof webhook.handlePineLabsWebhook, 'function');
    assert.equal(typeof webhook.handleMockPineLabsWebhook, 'function');
});

test('idempotency utility exposes the claim/complete/unknown contract', async () => {
    const idempotency = await import('../src/utils/idempotency.js');
    assert.equal(typeof idempotency.claimIdempotency, 'function');
    assert.equal(typeof idempotency.markIdempotencyCompleted, 'function');
    assert.equal(typeof idempotency.markIdempotencyUnknown, 'function');
    assert.equal(typeof idempotency.buildRequestHash, 'function');
});

test('UPI payment route requires authentication', async () => {
    const { default: router } = await import('../src/routes/Payment/PineLabs/Payment/UPI/pineLabsUpiPayment.route.js');

    const layer = router.stack.find((entry) => entry.route && entry.route.path === '/order/:orderId/upi/payments');
    assert.ok(layer, 'UPI payment route should be registered');

    // The route must have more than just the handler (i.e. auth middleware ran first).
    assert.ok(layer.route.stack.length >= 2, 'UPI route should have auth middleware before the handler');
});

test('state machine refuses the documented illegal regressions', async () => {
    const { canTransition } = await import('../src/securepay/stateMachine.js');
    assert.equal(canTransition('FAILED', 'PROCESSED'), false);
    assert.equal(canTransition('PROCESSED', 'PENDING'), false);
    assert.equal(canTransition('AUTHORIZED', 'PROCESSED'), true);
});
