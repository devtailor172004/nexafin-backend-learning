import fetch from 'node-fetch';
import PineLabsToken from '../../../../models/PineLabsToken.js';
import sequelize from '../../../../config/db.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { ApiResponse } from '../../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../../utils/userHelper.js';
import logger from '../../../../utils/logger.js';
import { getClientIp } from '../../../../utils/getClientIp.js';

/**
 * Checks database for a valid cached Pine Labs Access Token for the specified user.
 * If none exists or the cached one is close to expiring (within 5 minutes),
 * fetches a new token from Pine Labs Sandbox/Production API, stores it, and returns it.
 * 
 * @param {number} userId - The ID of the authenticated user
 * @returns {Promise<{accessToken: string, expiresAt: Date}>} The active JWT Access Token and its expiry date
 */
export const getOrGeneratePineLabsToken = async (userId, customClientId = null, customClientSecret = null, ipAddress = null) => {
    const clientId = customClientId;
    const clientSecret = customClientSecret;
    const baseUrl = process.env.PINELABS_BASE_URL;

    if (!userId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "userId is required to generate or retrieve a token."
        );
    }

    if (!clientId || !clientSecret) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "NxPay credentials (clientId and clientSecret) must be provided in the request body."
        );
    }

    try {
        // Retrieve cached token specifically for this userId
        let cachedTokenRecord = await PineLabsToken.findOne({
            where: { userId }
        });

        // Check if token exists, matches the clientId being used, and has more than 5 minutes of lifetime remaining
        const BUFFER_MS = 5 * 60 * 1000; // 5 minutes safety buffer
        if (
            cachedTokenRecord &&
            cachedTokenRecord.clientId === clientId &&
            (new Date(cachedTokenRecord.expiresAt).getTime() - Date.now() > BUFFER_MS)
        ) {
            return {
                accessToken: cachedTokenRecord.accessToken,
                expiresAt: cachedTokenRecord.expiresAt
            };
        }

        // Token is expired, expiring soon, or non-existent. Fetch a new token.
        const response = await fetch(`${baseUrl}/api/auth/v1/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            })
        });

        const textResponse = await response.text();

        if (response.status !== 200) {
            let errorMessage = `NxPay authorization API returned status code ${response.status}.`;
            try {
                const parsedError = JSON.parse(textResponse);
                if (parsedError?.message) {
                    errorMessage = parsedError.message;
                }
            } catch (jsonErr) {
                // Ignore parse errors, fallback to default message
            }
            logger.error(`NxPay Token Generation Failed: ${errorMessage}`);
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, errorMessage);
        }

        const data = JSON.parse(textResponse);
        const { access_token, expires_at } = data;

        if (!access_token || !expires_at) {
            throw new ApiError(
                HTTP_STATUS.BAD_REQUEST,
                "Invalid response received from NxPay authentication service."
            );
        }

        const parsedExpiresAt = new Date(expires_at);

        // Save token to the database atomically
        await sequelize.transaction(async (t) => {
            if (cachedTokenRecord) {
                cachedTokenRecord.accessToken = access_token;
                cachedTokenRecord.expiresAt = parsedExpiresAt;
                cachedTokenRecord.clientId = clientId;
                cachedTokenRecord.ipAddress = ipAddress;
                await cachedTokenRecord.save({ transaction: t });
            } else {
                await PineLabsToken.create({
                    userId: userId,
                    clientId: clientId,
                    accessToken: access_token,
                    expiresAt: parsedExpiresAt,
                    ipAddress: ipAddress
                }, { transaction: t });
            }
        });

        return {
            accessToken: access_token,
            expiresAt: parsedExpiresAt
        };

    } catch (error) {
        // If it is a custom ApiError, rethrow it directly
        if (error instanceof ApiError || error.statusCode) throw error;

        logger.error("Error generating NxPay token:", error);

        // Handle database validation constraints gracefully
        if (error.name === 'SequelizeValidationError' && error.errors) {
            const details = error.errors.map(e => `${e.path}: ${e.message}`).join(', ');
            throw new ApiError(
                HTTP_STATUS.BAD_REQUEST,
                `Database Validation Error: ${details}`
            );
        }

        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `Failed to communicate with NxPay token API: ${error.message}`
        );
    }
};

/**
 * Retrieves a valid cached Pine Labs Access Token from the database.
 * Throws an ApiError if no valid token exists or if the token is close to expiring (within 5 minutes).
 *
 * @param {number} userId - The ID of the authenticated user
 * @returns {Promise<{accessToken: string, expiresAt: Date}>} The active JWT Access Token and its expiry date
 */
export const getValidCachedPineLabsToken = async (userId) => {
    if (!userId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "userId is required to retrieve a token."
        );
    }

    const cachedTokenRecord = await PineLabsToken.findOne({
        where: { userId }
    });

    const BUFFER_MS = 5 * 60 * 1000; // 5 minutes safety buffer
    if (!cachedTokenRecord || (new Date(cachedTokenRecord.expiresAt).getTime() - Date.now() <= BUFFER_MS)) {
        throw new ApiError(
            HTTP_STATUS.UNAUTHORIZED,
            "NxPay access token not found or expired. Please generate a token first."
        );
    }

    return {
        accessToken: cachedTokenRecord.accessToken,
        expiresAt: cachedTokenRecord.expiresAt
    };
};

/**
 * @desc    Get or generate Pine Labs Access Token
 * @route   GET /api/payment/pinelabs/token
 * @access  Private (User/Admin)
 */
export const getActiveToken = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    // Retrieve client credentials optionally passed in the request body
    const { clientId, clientSecret } = req.body;

    // Securely extract client IP address using the utility
    const ipAddress = getClientIp(req);

    const { accessToken, expiresAt } = await getOrGeneratePineLabsToken(userId, clientId, clientSecret, ipAddress);

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                access_token: accessToken,
                expires_at: expiresAt
            },
            "NxPay access token retrieved successfully!"
        )
    );
});
