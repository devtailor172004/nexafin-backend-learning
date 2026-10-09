import jwt from 'jsonwebtoken';
import sequelize from "../../config/db.js";
import User from "../../models/User.js";
import BlacklistedToken from "../../models/BlacklistedToken.js";
import { sendRegistrationSMS } from "../../utils/smsService.js";
import { sendForgotPasswordEmail } from "../../utils/emailService.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { HTTP_STATUS } from "../../utils/httpStatus.js";
import { getAuthenticatedUser } from "../../utils/userHelper.js";
import logger from "../../utils/logger.js";
import { writeAuditLog } from "../../securepay/auditLog.js";
import {
    AUTH_MESSAGES,
    validatePassword,
    createOtpChallenge,
    consumeOtpChallenge,
    registerFailedLogin,
    clearLoginFailures,
    isLocked,
    revokeExistingSessions
} from "../../securepay/authHardening.js";

/**
 * @desc    Login user and obtain JWT token
 * @route   POST /api/auth/login
 * @access  Public
 */
export const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "email and password are required.");
    }

    const user = await User.findOne({ where: { email } });

    /**
     * Single generic failure path. Unknown account, locked account and wrong
     * password are indistinguishable to the caller — only the audit trail
     * records which of them actually happened.
     */
    const failGeneric = async (reason) => {
        await writeAuditLog({
            actorId: user?.id || null,
            action: 'AUTH_LOGIN_FAILED',
            entityType: 'user',
            entityId: user?.uuid || null,
            description: 'Login rejected.',
            outcome: 'DENIED',
            reason,
            source: 'AUTH',
            ipAddress: req.ip,
            requestId: req.id || null
        });
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
    };

    if (!user) return failGeneric('unknown account');

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        // While an account is already locked the counter is left alone, so a
        // locked account cannot be churned back into an unlocked state.
        if (!isLocked(user)) await registerFailedLogin(user);
        return failGeneric('incorrect password');
    }

    // The supplied password was correct, so telling this caller the account is
    // locked reveals nothing they did not already know — it does not disclose
    // whether the account exists to anyone guessing.
    if (isLocked(user)) {
        const secondsLeft = Math.max(
            1,
            Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000)
        );
        const minutesLeft = Math.max(1, Math.ceil(secondsLeft / 60));

        await writeAuditLog({
            actorId: user.id,
            action: 'AUTH_LOGIN_DENIED',
            entityType: 'user',
            entityId: user.uuid,
            description: 'Correct password supplied while the account was locked.',
            outcome: 'DENIED',
            reason: 'account temporarily locked',
            source: 'AUTH',
            ipAddress: req.ip
        });

        throw new ApiError(
            HTTP_STATUS.TOO_MANY_REQUESTS || 429,
            `Account temporarily locked after repeated failed sign-in attempts. Try again in about ${minutesLeft} minute(s), or run \`npm run auth:unlock\`.`
        );
    }

    // Credentials are correct, so revealing the block does not leak existence.
    if (user.is_blocked) {
        await writeAuditLog({
            actorId: user.id,
            action: 'AUTH_LOGIN_DENIED',
            entityType: 'user',
            entityId: user.uuid,
            description: 'Blocked account attempted to sign in.',
            outcome: 'DENIED',
            reason: 'account blocked',
            source: 'AUTH',
            ipAddress: req.ip
        });
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Your account has been blocked by the admin.");
    }

    await clearLoginFailures(user);

    const token = user.generateToken();

    await writeAuditLog({
        actorId: user.id,
        actorRole: user.role,
        action: 'AUTH_LOGIN_SUCCESS',
        entityType: 'user',
        entityId: user.uuid,
        description: 'Login successful.',
        outcome: 'SUCCESS',
        source: 'AUTH',
        ipAddress: req.ip
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                token: token,
                user: {
                    id: user.id,
                    uuid: user.uuid,
                    fullName: user.fullName,
                    email: user.email,
                    role: user.role
                }
            },
            "Login successful!"
        )
    );
});

/**
 * @desc    Get currently logged in user profile
 * @route   GET /api/auth/profile
 * @access  Private
 */
export const getUserProfile = asyncHandler(async (req, res) => {
    const user = await getAuthenticatedUser(req);

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, user, "User profile fetched successfully.")
    );
});

/**
 * @desc    Send OTP or reset password via email
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
export const forgotPassword = asyncHandler(async (req, res) => {
    const { email, otp, newPassword, confirmPassword } = req.body;

    if (!email || String(email).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "email address is required.");
    }

    const formattedEmail = String(email).trim().toLowerCase();

    const user = await User.findOne({ where: { email: formattedEmail } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User with this email address not found!");
    }

    // If OTP is provided, perform validation and reset password atomically
    if (otp !== undefined && otp !== null && otp !== "") {
        if (!newPassword || !confirmPassword) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "newPassword and confirmPassword are required.");
        }

        if (newPassword !== confirmPassword) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "newPassword and confirmPassword do not match.");
        }

        const policy = validatePassword(newPassword);
        if (!policy.ok) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, policy.errors.join(' '));
        }

        // Verify the single-use, expiring, attempt-limited challenge. Only a
        // hash of the code is stored, and it is consumed exactly once.
        await consumeOtpChallenge({
            email: formattedEmail,
            code: String(otp).trim(),
            purpose: 'PASSWORD_RESET'
        });

        // Apply the new password and move `password_changed_at` in ONE
        // transaction, so a session cannot slip through the gap between them.
        await sequelize.transaction(async (t) => {
            user.password = newPassword; // Hashed by the beforeUpdate model hook
            await user.save({ transaction: t });
            await revokeExistingSessions(user, { transaction: t });
        });

        await writeAuditLog({
            actorId: user.id,
            action: 'AUTH_PASSWORD_RESET',
            entityType: 'user',
            entityId: user.uuid,
            description: 'Password reset completed; all prior sessions revoked.',
            outcome: 'SUCCESS',
            source: 'AUTH',
            ipAddress: req.ip,
            critical: true
        });

        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, null, AUTH_MESSAGES.PASSWORD_CHANGED)
        );
    }

    // Otherwise: issue a new single-use challenge. The plaintext code is only
    // ever returned to the caller for delivery — it is never persisted or logged.
    const { code: generatedOtp } = await createOtpChallenge({
        email: formattedEmail,
        purpose: 'PASSWORD_RESET'
    });

    let emailSent = false;
    try {
        await sendForgotPasswordEmail({
            email: formattedEmail,
            otp: generatedOtp
        });
        emailSent = true;
    } catch (err) {
        logger.error("Failed to send forgot password email:", err);
        if (process.env.NODE_ENV === 'production') {
            throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, "Failed to send verification OTP email. Please try again later.");
        }
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                emailSent,
                autoGeneratedOtp: process.env.NODE_ENV !== 'production' ? generatedOtp : undefined
            },
            "OTP sent successfully to your email address."
        )
    );
});

/**
 * @desc    Logout user and invalidate token
 * @route   POST /api/auth/logout
 * @access  Private
 */
export const logout = asyncHandler(async (req, res) => {
    let token = req.headers.authorization;
    if (token && token.startsWith("Bearer ")) {
        token = token.split(" ")[1];
        try {
            const decoded = jwt.decode(token);
            const expiresAt = decoded && decoded.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);
            await BlacklistedToken.create({
                token,
                expiresAt
            });
        } catch (err) {
            // Ignore decoding issues or duplicate insertions, proceed with logout
        }
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {}, "Logout successful!")
    );
});