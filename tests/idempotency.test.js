import test from 'node:test';
import assert from 'node:assert/strict';

import { stableStringify, buildRequestHash } from '../src/utils/idempotency.js';

/**
 * The idempotency layer hashes (method, path, params, query, body) so that the
 * same logical request always produces the same hash and a DIFFERENT request
 * can never collide onto an existing key.
 */

test('stableStringify is key-order independent', () => {
    const a = { b: 1, a: { d: [1, 2], c: 3 } };
    const b = { a: { c: 3, d: [1, 2] }, b: 1 };
    assert.equal(stableStringify(a), stableStringify(b));
});

test('stableStringify preserves array order', () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('stableStringify handles primitives and null', () => {
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(5), '5');
    assert.equal(stableStringify('x'), '"x"');
});

const request = (overrides = {}) => ({
    method: 'POST',
    originalUrl: '/api/payment/nxpay/order',
    params: {},
    query: {},
    body: { amount: 5000, notes: 'x', purchase_details: { customer: { email_id: 'a@b.c', first_name: 'A' } } },
    ...overrides
});

test('equivalent payloads with different key order hash identically', () => {
    const first = buildRequestHash(request());
    const second = buildRequestHash(request({
        body: {
            purchase_details: { customer: { first_name: 'A', email_id: 'a@b.c' } },
            notes: 'x',
            amount: 5000
        }
    }));
    assert.equal(first, second);
});

test('a different amount produces a different hash', () => {
    const a = buildRequestHash(request({ body: { amount: 5000 } }));
    const b = buildRequestHash(request({ body: { amount: 5001 } }));
    assert.notEqual(a, b);
});

test('a different route produces a different hash', () => {
    const a = buildRequestHash(request({ originalUrl: '/api/payment/nxpay/order' }));
    const b = buildRequestHash(request({ originalUrl: '/api/payment/nxpay/initiate' }));
    assert.notEqual(a, b);
});

test('a different path param produces a different hash', () => {
    const a = buildRequestHash(request({ params: { orderId: 'order-1' } }));
    const b = buildRequestHash(request({ params: { orderId: 'order-2' } }));
    assert.notEqual(a, b);
});

test('a different query string produces a different hash', () => {
    const a = buildRequestHash(request({ query: {} }));
    const b = buildRequestHash(request({ query: { force: 'true' } }));
    assert.notEqual(a, b);
});

test('the hash is a 64 character hex sha256 digest', () => {
    assert.match(buildRequestHash(request()), /^[0-9a-f]{64}$/);
});
