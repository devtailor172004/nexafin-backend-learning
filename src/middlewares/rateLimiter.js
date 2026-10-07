import rateLimit from 'express-rate-limit';
import { ApiResponse } from '../utils/ApiResponse.js';
import { HTTP_STATUS } from '../utils/httpStatus.js';

// Standardized rate limit response handler
const rateLimitHandler = (message) => (req, res /*, next, options */) => {
    const statusCode = HTTP_STATUS.TOO_MANY_REQUESTS || 429;
    return res.status(statusCode).json(
        new ApiResponse(
            statusCode,
            null,
            message || "Too many requests from this IP, please try again later."
        )
    );
};


/**
 * Strict Rate Limiter for Authentication (Login)
 * Limit: 5 requests per 1 minute per IP
 */
export const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // Limit each IP to 5 login requests per windowMs
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    handler: rateLimitHandler("Too many login attempts. Please try again after 1 minute.")
});

/**
 * Strict Rate Limiter for OTP Generation & Reset Password
 * Limit: 5 requests per 15 minutes per IP
 */
export const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 OTP requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many OTP requests. Please try again after 15 minutes.")
});

/**
 * Rate Limiter for Public DigiLocker Callback Routes
 * Limit: 20 requests per 15 minutes per IP
 */
export const digilockerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Limit each IP to 20 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many DigiLocker callback requests. Please try again later.")
});

/**
 * Global API Fallback Rate Limiter
 * Limit: 100 requests per 15 minutes per IP
 */
export const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many API requests from this IP. Please try again after 15 minutes.")
});
