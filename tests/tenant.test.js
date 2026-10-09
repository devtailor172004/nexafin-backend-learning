import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveTenantId,
    assertResourceOwner,
    assertAdmin,
    isAdmin,
    tenantScope
} from '../src/securepay/tenant.js';

const reqFor = (user) => ({ user, params: {}, query: {}, body: {} });

/* ---------------------------- tenant identity ---------------------------- */

test('the tenant id comes from the authenticated identity', () => {
    assert.equal(resolveTenantId(reqFor({ id: 7, role: 'User' })), 7);
});

test('an unauthenticated request has no tenant and is rejected', () => {
    assert.throws(() => resolveTenantId(reqFor(null)), (err) => err.statusCode === 401);
    assert.throws(() => resolveTenantId(reqFor({})), (err) => err.statusCode === 401);
    assert.throws(() => resolveTenantId(reqFor({ id: 'abc' })), (err) => err.statusCode === 401);
});

/* --------------------------- ownership (BOLA) ---------------------------- */

test('retailer A can access their own record', () => {
    assert.equal(
        assertResourceOwner({ actorId: 1, ownerId: 1, resourceType: 'Payment' }),
        true
    );
});

test("retailer A cannot access retailer B's protected record", () => {
    assert.throws(
        () => assertResourceOwner({ actorId: 1, ownerId: 2, resourceType: 'Payment' }),
        (err) => err.statusCode === 403
    );
});

test('a client-supplied id cannot bypass ownership — only the authenticated actor matters', () => {
    // The helper only ever receives the authenticated actorId; a body/param
    // ownerId of 2 is what is compared, and it must not grant access to actor 1.
    assert.throws(
        () => assertResourceOwner({ actorId: 1, ownerId: 2, resourceType: 'Order' }),
        (err) => err.statusCode === 403
    );
});

test('a missing owner is a 404, not a leak of another tenant', () => {
    assert.throws(
        () => assertResourceOwner({ actorId: 1, ownerId: null, resourceType: 'Wallet' }),
        (err) => err.statusCode === 404
    );
});

test('discloseExistence=false returns 404 so the resource existence is not revealed', () => {
    assert.throws(
        () => assertResourceOwner({ actorId: 1, ownerId: 2, resourceType: 'Payment', discloseExistence: false }),
        (err) => err.statusCode === 404
    );
});

test('ownership checks work for wallets, beneficiaries and payouts alike', () => {
    ['Wallet', 'Beneficiary', 'Payout', 'Profile', 'Risk event'].forEach((type) => {
        assert.throws(
            () => assertResourceOwner({ actorId: 10, ownerId: 11, resourceType: type }),
            (err) => err.statusCode === 403
        );
    });
});

/* ------------------------------- admin role ------------------------------ */

test('a normal user cannot access an admin endpoint', () => {
    assert.throws(() => assertAdmin(reqFor({ id: 1, role: 'User' })), (err) => err.statusCode === 403);
    assert.throws(() => assertAdmin(reqFor(null)), (err) => err.statusCode === 403);
    assert.throws(() => assertAdmin(reqFor({ id: 1, role: 'Branch' })), (err) => err.statusCode === 403);
});

test('an admin passes the admin guard', () => {
    assert.equal(assertAdmin(reqFor({ id: 1, role: 'Admin' })), true);
    assert.equal(isAdmin(reqFor({ id: 1, role: 'Admin' })), true);
    assert.equal(isAdmin(reqFor({ id: 1, role: 'User' })), false);
});

/* ------------------------------ query scoping ---------------------------- */

test('a normal user query is scoped to their own id', () => {
    assert.deepEqual(tenantScope(reqFor({ id: 5, role: 'User' })), { userId: 5 });
});

test('an admin may opt out of scoping only when explicitly allowed', () => {
    assert.deepEqual(tenantScope(reqFor({ id: 9, role: 'Admin' }), { allowAdmin: true }), {});
    // Without allowAdmin an admin is still scoped to their own id.
    assert.deepEqual(tenantScope(reqFor({ id: 9, role: 'Admin' })), { userId: 9 });
});
