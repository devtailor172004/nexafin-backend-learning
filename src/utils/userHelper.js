import User from '../models/User.js';
import { ApiError } from './ApiError.js';
import { HTTP_STATUS } from './httpStatus.js';

/**
 * Utility function to verify and retrieve the logged-in user from request
 * @param {Object} req - Express request object
 * @param {Array<string>|null} attributes - Selective fields to fetch (optimizes SQL query performance)
 * @returns {Promise<User>} User instance
 */
export const getAuthenticatedUser = async (req, attributes = null) => {
    const userId = req.user?.id;
    if (!userId) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Access Denied. Authentication required.");
    }

    const queryOptions = attributes ? { attributes } : {};
    const user = await User.findByPk(userId, queryOptions);

    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    return user;
};
