import test from 'node:test';
import assert from 'node:assert/strict';

import securityRouter from '../src/routes/SecurePay/security.route.js';
import { FRAUD_LAB_SCENARIOS, isFraudLabEnabled } from '../src/securepay/fraudLab.js';

const routes = () => securityRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
        handlers: layer.route.stack.length
    }));

test('every documented Security Center route is registered', () => {
    const paths = routes().map((r) => r.path);
    [
        '/overview',
        '/events',
        '/events/:uuid',
        '/events/:uuid/review',
        '/freezes',
        '/freezes/:userId/release',
        '/incidents',
        '/incidents/:uuid',
        '/audit/integrity',
        '/ledger/integrity',
        '/scenarios',
        '/scenarios/:id/run'
    ].forEach((expected) => {
        assert.ok(paths.includes(expected), `expected route ${expected}, got: ${paths.join(', ')}`);
    });
});

test('every security route has an authorization middleware in front of the handler', () => {
    // verifyAdmin + handler = at least two handlers on every non-stream route.
    for (const route of routes()) {
        assert.ok(
            route.handlers >= 2,
            `route ${route.path} should be admin-guarded (handlers=${route.handlers})`
        );
    }
});

test('the sensitive state-changing routes accept POST only', () => {
    const byPath = new Map(routes().map((r) => [r.path, r]));
    for (const path of ['/events/:uuid/review', '/freezes', '/freezes/:userId/release', '/scenarios/:id/run']) {
        const route = byPath.get(path);
        assert.ok(route, `missing route ${path}`);
        assert.deepEqual(route.methods, ['post'], `${path} must be POST only`);
    }
});

test('all nine Fraud Lab scenarios are declared with metadata', () => {
    assert.equal(FRAUD_LAB_SCENARIOS.length, 9);
    const ids = FRAUD_LAB_SCENARIOS.map((s) => s.id);
    assert.deepEqual(ids, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    for (const scenario of FRAUD_LAB_SCENARIOS) {
        assert.ok(scenario.name && scenario.whatItTests && scenario.expected, `scenario ${scenario.id} needs metadata`);
    }
});

test('the Fraud Lab is enabled in a non-production environment', () => {
    // The test runner does not set NODE_ENV=production.
    assert.equal(isFraudLabEnabled(), true);
});
