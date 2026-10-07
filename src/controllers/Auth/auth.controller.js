import jwt from 'jsonwebtoken';
import sequelize from "../../config/db.js";
import User from "../../models/User.js";
import Otp from "../../models/Otp.js";
import BlacklistedToken from "../../models/BlacklistedToken.js";
import { sendRegistrationSMS } from "../../utils/smsService.js";
import { sendForgotPasswordEmail } from "../../utils/emailService.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { HTTP_STATUS } from "../../utils/httpStatus.js";
import { getAuthenticatedUser } from "../../utils/userHelper.js";
import logger from "../../utils/logger.js";

/**
 * @desc    Login user and obtain JWT token
 * @route   POST /api/auth/login
 * @access  Public
 */
export const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ where: { email } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    if (user.is_blocked) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Your account has been blocked by the admin.");
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Invalid credentials!");
    }

    const token = user.generateToken();

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

        if (newPassword.length < 6 || newPassword.length > 10) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Password must be between 6 and 10 characters long.");
        }

        if (newPassword !== confirmPassword) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "newPassword and confirmPassword do not match.");
        }

        // Execute password reset and OTP destruction inside a managed transaction
        await sequelize.transaction(async (t) => {
            const otpRecord = await Otp.findOne({ where: { email: formattedEmail }, transaction: t });

            if (!otpRecord || otpRecord.otp !== String(otp).trim()) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid OTP.");
            }

            // Check expiry
            if (new Date() > new Date(otpRecord.expires_at)) {
                await otpRecord.destroy({ transaction: t });
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "OTP has expired.");
            }

            // Reset password
            user.password = newPassword; // Hashed automatically by the beforeUpdate model hook
            await user.save({ transaction: t });

            // Delete OTP record from DB
            await otpRecord.destroy({ transaction: t });
        });

        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, null, "Password reset successful! You can now login with your new password.")
        );
    }

    // Otherwise: Generate and send OTP atomically
    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Valid for 5 minutes

    await sequelize.transaction(async (t) => {
        // Delete any existing OTP for this email (upsert logic)
        await Otp.destroy({ where: { email: formattedEmail }, transaction: t });

        // Save new OTP to DB
        await Otp.create({ email: formattedEmail, otp: generatedOtp, expires_at: expiresAt }, { transaction: t });
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