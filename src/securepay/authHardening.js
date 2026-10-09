import crypto from 'crypto';
import bcrypt from 'bcryptjs';

import Otp from '../models/Otp.js';
import User from '../models/User.js';
import sequelize from '../config/db.js';
import { ApiError } from '../utils/ApiError.js';
import { HTTP_STATUS } from '../utils/httpStatus.js';
import logger from '../utils/logger.js';

/**
 * Authentication and session hardening.
 *
 * The pure helpers at the top are the ones unit-tested without a database; the
 * DB-backed challenge/lockout helpers below them are used by the auth
 * controller.
 */

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/**
 * Deliberately generic. Login never reveals whether an account exists, whether
 * it is locked, or whether the password was the wrong part.
 */
export const AUTH_MESSAGES = Object.freeze({
    INVALID_CREDENTIALS: 'Invalid email or password.',
    INVALID_OTP: 'Invalid or expired verification code.',
    TOO_MANY_ATTEMPTS: 'Too many attempts. Please try again later.',
    PASSWORD_CHANGED: 'Password updated. Please sign in again.'
});

/* ------------------------------------------------------------------ *
 * Password policy
 * ------------------------------------------------------------------ */

export const PASSWORD_POLICY = Object.freeze({
    minLength: 10,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: true,
    // Rejected regardless of length.
    bannedSubstrings: ['password', 'securepay', '123456', 'qwerty', 'changeme']
});

export const validatePassword = (password) => {
    const value = typeof password === 'string' ? password : '';
    const errors = [];

    if (value.length < PASSWORD_POLICY.minLength) {
        errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters long.`);
    }
    if (value.length > PASSWORD_POLICY.maxLength) {
        errors.push(`Password must be at most ${PASSWORD_POLICY.maxLength} characters long.`);
    }
    if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(value)) errors.push('Password must contain an uppercase letter.');
    if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(value)) errors.push('Password must contain a lowercase letter.');
    if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(value)) errors.push('Password must contain a digit.');
    if (PASSWORD_POLICY.requireSymbol && !/[^A-Za-z0-9]/.test(value)) errors.push('Password must contain a symbol.');

    const lower = value.toLowerCase();
    if (PASSWORD_POLICY.bannedSubstrings.some((s) => lower.includes(s))) {
        errors.push('Password must not contain common or product-related words.');
    }

    return { ok: errors.length === 0, errors };
};

/* ------------------------------------------------------------------ *
 * OTP challenge primitives
 * ------------------------------------------------------------------ */

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/** Cryptographically-random numeric OTP, fixed width. */
export const generateOtp = (length = OTP_LENGTH) => {
    let out = '';
    while (out.length < length) {
        out += String(crypto.randomInt(0, 10));
    }
    return out;
};

export const hashOtp = (otp) => bcrypt.hash(String(otp), 10);

export const verifyOtpHash = (otp, hash) => {
    if (!hash) return Promise.resolve(false);
    return bcrypt.compare(String(otp), hash);
};

/* ------------------------------------------------------------------ *
 * Lockout policy (pure)
 * ------------------------------------------------------------------ */

export const LOCKOUT_MAX_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS) || 5;
export const LOCKOUT_MINUTES = Number(process.env.AUTH_LOCKOUT_MINUTES) || 15;

/**
 * Computes the lockout state after a failed login.
 * The lockout is bounded so it cannot be used to permanently deny service to a
 * legitimate user, and it resets on the next successful login.
 */
export const computeLockout = ({
    failedCount,
    now = Date.now(),
    maxAttempts = LOCKOUT_MAX_ATTEMPTS,
    lockoutMinutes = LOCKOUT_MINUTES
}) => {
    const count = Number(failedCount) + 1;
    const locked = count >= maxAttempts;
    return {
        failedCount: locked ? 0 : count,
        remainingAttempts: locked ? 0 : maxAttempts - count,
        locked,
        lockedUntil: locked ? new Date(now + lockoutMinutes * 60_000) : null
    };
};

export const isLocked = (user, now = Date.now()) =>
    Boolean(user?.locked_until) && new Date(user.locked_until).getTime() > now;

/* ------------------------------------------------------------------ *
 * Session revocation (pure)
 * ------------------------------------------------------------------ */

/**
 * A JWT issued before the user's password last changed must be rejected. This is
 * how a password reset invalidates previously issued sessions without needing to
 * enumerate every outstanding token.
 */
export const shouldRevokeSession = ({ tokenIssuedAtSeconds, passwordChangedAt }) => {
    if (!passwordChangedAt) return false;
    const issuedAtMs = Number(tokenIssuedAtSeconds) * 1000;
    if (!Number.isFinite(issuedAtMs)) return true;
    return issuedAtMs < new Date(passwordChangedAt).getTime() - 1000; // 1s skew allowance
};

/* ------------------------------------------------------------------ *
 * DB-backed helpers
 * ------------------------------------------------------------------ */

/**
 * Issues a single-use, expiring OTP challenge. Only the hash is stored.
 * Returns the plaintext code so the caller can deliver it; it is never
 * persisted or logged.
 */
export const createOtpChallenge = async ({ email, purpose = 'PASSWORD_RESET', ttlMs = OTP_TTL_MS }) => {
    const normalizedEmail = String(email).trim().toLowerCase();
    const code = generateOtp();
    const otpHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + ttlMs);

    await sequelize.transaction(async (t) => {
        await Otp.destroy({ where: { email: normalizedEmail }, transaction: t });
        await Otp.create({
            email: normalizedEmail,
            otpHash,
            purpose,
            attempts: 0,
            maxAttempts: OTP_MAX_ATTEMPTS,
            expires_at: expiresAt
        }, { transaction: t });
    });

    return { email: normalizedEmail, code, expiresAt };
};

/**
 * Verifies and consumes an OTP challenge.
 *
 * - expired challenges are destroyed and rejected
 * - each wrong code increments an attempt counter
 * - exceeding the attempt limit destroys the challenge (no brute force)
 * - a correct code is consumed exactly once
 *
 * @throws {ApiError} with a generic message in every failure case
 */
export const consumeOtpChallenge = async ({ email, code, purpose = 'PASSWORD_RESET' }) => {
    const normalizedEmail = String(email).trim().toLowerCase();

    return sequelize.transaction(async (t) => {
        const record = await Otp.findOne({
            where: { email: normalizedEmail, purpose },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        if (!record) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, AUTH_MESSAGES.INVALID_OTP);
        }

        if (new Date() > new Date(record.expires_at)) {
            await record.destroy({ transaction: t });
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, AUTH_MESSAGES.INVALID_OTP);
        }

        if (record.consumedAt) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, AUTH_MESSAGES.INVALID_OTP);
        }

        const matches = await verifyOtpHash(code, record.otpHash);
        if (!matches) {
            record.attempts = (Number(record.attempts) || 0) + 1;
            if (record.attempts >= (Number(record.maxAttempts) || OTP_MAX_ATTEMPTS)) {
                await record.destroy({ transaction: t });
                throw new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS || 429, AUTH_MESSAGES.TOO_MANY_ATTEMPTS);
            }
            await record.save({ transaction: t });
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, AUTH_MESSAGES.INVALID_OTP);
        }

        // Correct code: consume exactly once.
        record.consumedAt = new Date();
        await record.save({ transaction: t });
        await record.destroy({ transaction: t });

        return { email: normalizedEmail };
    });
};

/** Applies the bounded lockout policy after a failed login. */
export const registerFailedLogin = async (user, { now = Date.now() } = {}) => {
    if (!user) return null;
    const state = computeLockout({ failedCount: user.failed_login_attempts || 0, now });
    user.failed_login_attempts = state.failedCount;
    user.locked_until = state.lockedUntil;
    await user.save();
    return state;
};

export const clearLoginFailures = async (user) => {
    if (!user) return;
    if ((user.failed_login_attempts || 0) !== 0 || user.locked_until) {
        user.failed_login_attempts = 0;
        user.locked_until = null;
        await user.save();
    }
};

/**
 * Invalidates every previously issued session for a user by moving
 * `password_changed_at` forward. `verifyToken` compares the token's `iat`
 * against this value.
 */
export const revokeExistingSessions = async (user, { transaction = null } = {}) => {
    user.password_changed_at = new Date();
    await user.save({ transaction });
    logger.info(`Sessions revoked for user ${user.id} after a credential change.`);
    return user.password_changed_at;
};

export default validatePassword;
