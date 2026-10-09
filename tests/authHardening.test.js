import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AUTH_MESSAGES,
    PASSWORD_POLICY,
    validatePassword,
    generateOtp,
    hashOtp,
    verifyOtpHash,
    computeLockout,
    isLocked,
    shouldRevokeSession
} from '../src/securepay/authHardening.js';

/* ------------------------------ generic errors --------------------------- */

test('login failures share one generic message that reveals nothing', () => {
    assert.equal(AUTH_MESSAGES.INVALID_CREDENTIALS, 'Invalid email or password.');
    // The message must not hint at which half was wrong, or whether the account exists.
    const lower = AUTH_MESSAGES.INVALID_CREDENTIALS.toLowerCase();
    ['not found', 'no account', 'unknown', 'does not exist', 'incorrect password', 'wrong password'].forEach((leak) => {
        assert.ok(!lower.includes(leak), `failure message leaks: ${leak}`);
    });
});

/* ------------------------------ password policy -------------------------- */

test('a strong password is accepted', () => {
    assert.equal(validatePassword('Str0ng!Passphrase').ok, true);
});

test('short passwords are rejected', () => {
    const result = validatePassword('Ab1!xy');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /at least/.test(e)));
});

test('missing character classes are rejected', () => {
    assert.ok(validatePassword('alllowercase1!').errors.some((e) => /uppercase/.test(e)));
    assert.ok(validatePassword('ALLUPPERCASE1!').errors.some((e) => /lowercase/.test(e)));
    assert.ok(validatePassword('NoDigitsHere!!').errors.some((e) => /digit/.test(e)));
    assert.ok(validatePassword('NoSymbolsHere11').errors.some((e) => /symbol/.test(e)));
});

test('common and product-related words are rejected', () => {
    assert.ok(validatePassword('MyPassword123!').errors.some((e) => /common or product/.test(e)));
    assert.ok(validatePassword('SecurePay@2026').errors.some((e) => /common or product/.test(e)));
});

test('non-string input is rejected rather than throwing', () => {
    assert.equal(validatePassword(undefined).ok, false);
    assert.equal(validatePassword(null).ok, false);
    assert.equal(validatePassword(1234567890).ok, false);
});

test('the documented policy is the one enforced', () => {
    assert.equal(validatePassword('a'.repeat(PASSWORD_POLICY.minLength - 1)).ok, false);
    assert.equal(validatePassword('A1!' + 'a'.repeat(PASSWORD_POLICY.minLength - 3)).ok, true);
});

/* ---------------------------------- OTP ---------------------------------- */

test('generated OTPs are six numeric digits', () => {
    for (let i = 0; i < 20; i += 1) {
        const otp = generateOtp();
        assert.equal(otp.length, 6);
        assert.match(otp, /^[0-9]{6}$/);
    }
});

test('generated OTPs are not a fixed sequence', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtp()));
    assert.ok(codes.size > 5, 'OTPs should vary between generations');
});

test('OTPs are stored hashed, never in plaintext', async () => {
    const code = '482913';
    const hash = await hashOtp(code);
    assert.notEqual(hash, code);
    assert.ok(hash.length > 20);
    assert.equal(await verifyOtpHash(code, hash), true);
    assert.equal(await verifyOtpHash('000000', hash), false);
});

test('verifying against a missing hash fails closed', async () => {
    assert.equal(await verifyOtpHash('123456', null), false);
    assert.equal(await verifyOtpHash('123456', undefined), false);
});

/* -------------------------------- lockout -------------------------------- */

test('failed attempts accumulate and report the remaining budget', () => {
    const first = computeLockout({ failedCount: 0, maxAttempts: 5 });
    assert.equal(first.failedCount, 1);
    assert.equal(first.remainingAttempts, 4);
    assert.equal(first.locked, false);

    const fourth = computeLockout({ failedCount: 3, maxAttempts: 5 });
    assert.equal(fourth.failedCount, 4);
    assert.equal(fourth.remainingAttempts, 1);
    assert.equal(fourth.locked, false);
});

test('the account locks at the configured limit and the counter resets', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const locked = computeLockout({ failedCount: 4, now, maxAttempts: 5, lockoutMinutes: 15 });
    assert.equal(locked.locked, true);
    assert.equal(locked.failedCount, 0);
    assert.equal(locked.remainingAttempts, 0);
    assert.equal(new Date(locked.lockedUntil).getTime(), now + 15 * 60_000);
});

test('the lockout is temporary so it cannot permanently deny a legitimate user', () => {
    const locked = computeLockout({ failedCount: 4, maxAttempts: 5, lockoutMinutes: 15 });
    assert.ok(locked.lockedUntil instanceof Date);
    assert.ok(new Date(locked.lockedUntil).getTime() > Date.now());
    assert.ok(locked.lockedUntil.getTime() - Date.now() <= 15 * 60_000 + 1000);
});

test('isLocked honours the expiry', () => {
    assert.equal(isLocked({ locked_until: new Date(Date.now() + 60_000) }), true);
    assert.equal(isLocked({ locked_until: new Date(Date.now() - 60_000) }), false);
    assert.equal(isLocked({ locked_until: null }), false);
    assert.equal(isLocked({}), false);
});

/* ---------------------------- session revocation ------------------------- */

test('a token issued before the last password change is revoked', () => {
    const passwordChangedAt = new Date('2026-01-01T12:00:00Z');
    const issuedBefore = Math.floor(new Date('2026-01-01T11:00:00Z').getTime() / 1000);
    const issuedAfter = Math.floor(new Date('2026-01-01T13:00:00Z').getTime() / 1000);

    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: issuedBefore, passwordChangedAt }), true);
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: issuedAfter, passwordChangedAt }), false);
});

test('users who never changed their password keep their sessions', () => {
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: 1, passwordChangedAt: null }), false);
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: 1, passwordChangedAt: undefined }), false);
});

test('a token without a usable issued-at value fails closed', () => {
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: undefined, passwordChangedAt: new Date() }), true);
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: 'nope', passwordChangedAt: new Date() }), true);
});

test('a small clock skew does not invalidate a fresh token', () => {
    // JWT `iat` has one-second resolution, so a token issued in the same second
    // as the credential change must not be treated as stale.
    const now = Date.now();
    const passwordChangedAt = new Date(now);
    const issued = Math.floor(now / 1000);
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: issued, passwordChangedAt }), false);
});

test('the revocation boundary is exactly the password change instant', () => {
    const changedAtMs = 1_800_000_000_000; // fixed instant
    const passwordChangedAt = new Date(changedAtMs);
    const justBefore = Math.floor((changedAtMs - 2_000) / 1000);
    const justAfter = Math.ceil((changedAtMs + 2_000) / 1000);

    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: justBefore, passwordChangedAt }), true);
    assert.equal(shouldRevokeSession({ tokenIssuedAtSeconds: justAfter, passwordChangedAt }), false);
});
