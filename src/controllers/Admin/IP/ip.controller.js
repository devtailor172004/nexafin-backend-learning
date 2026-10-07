import net from 'net';
import fetch from 'node-fetch';
import sequelize from '../../../config/db.js';
import User from '../../../models/User.js';
import UserIp from '../../../models/UserIp.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';
import { getPaginationParams, formatPaginatedResponse } from '../../../utils/paginationHelper.js';
import logger from '../../../utils/logger.js';

/**
 * @desc    Get list of all registered User IPs (Admin)
 * @route   GET /api/admin/ip
 * @access  Private (Admin)
 */
export const getAllUserIps = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 10 } = req.query;
    const { pageNum, limitNum, offset } = getPaginationParams(page, limit);

    const whereClause = {};
    if (status && ['approved', 'not approved'].includes(status)) {
        whereClause.status = status;
    }

    const { count, rows: ips } = await UserIp.findAndCountAll({
        where: whereClause,
        include: [{
            model: User,
            as: 'User',
            attributes: ['id', 'uuid', 'fullName', 'email', 'mobile']
        }],
        limit: limitNum,
        offset: offset,
        order: [['createdAt', 'DESC']]
    });

    const responseData = formatPaginatedResponse(count, ips, pageNum, limitNum, 'ips');

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, responseData, "User IP addresses list fetched successfully.")
    );
});

/**
 * @desc    Approve or Reject a user's IP status strictly by UUID (Admin)
 * @route   PUT /api/admin/ip/:uuid/status
 * @access  Private (Admin)
 */
export const updateUserIpStatus = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { status } = req.body;

    if (!status || !['approved', 'not approved'].includes(status)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Status is required and must be either 'approved' or 'not approved'.");
    }

    const userIp = await UserIp.findOne({ where: { uuid } });
    if (!userIp) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "IP address record not found!");
    }

    await sequelize.transaction(async (t) => {
        userIp.status = status;
        await userIp.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            userIp,
            `User IP address status updated to '${status}' successfully.`
        )
    );
});

/**
 * @desc    User-facing IP Registration API (User)
 * @route   POST /api/admin/ip/ip-check
 * @access  Private (User)
 */
export const ipAddressCheck = asyncHandler(async (req, res) => {
    const { ipAddress } = req.body;
 
    const user = await getAuthenticatedUser(req, ['id']);
    const userId = user.id;

    if (!ipAddress || String(ipAddress).trim() === '') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "ipAddress is required.");
    }

    const trimmedIp = String(ipAddress).trim();

    // Check if it is a valid IP address format
    if (net.isIP(trimmedIp) === 0) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid IP address format.");
    }

    // Check if the entered IP is from India
    const isLocal = trimmedIp === '::1' || trimmedIp === '127.0.0.1' || trimmedIp.endsWith('127.0.0.1') || trimmedIp === 'localhost';
    if (!isLocal) {
        try {
            const apiUrl = process.env.IP_API_URL;
            const response = await fetch(`${apiUrl}/${trimmedIp}`);
            const geo = await response.json();
            if (geo && geo.status === 'fail') {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid or unresolvable IP address: ${geo.message || 'unknown error'}`);
            }
            if (geo && geo.status === 'success' && geo.countryCode !== 'IN') {
                throw new ApiError(HTTP_STATUS.FORBIDDEN, `Access denied. Only Indian IP addresses are permitted. The entered IP originates from ${geo.country || 'unknown country'}.`);
            }
        } catch (err) {
            if (err instanceof ApiError) throw err;
            logger.error("IP Geolocation check failed: ", err);
            throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, "Unable to verify IP address origin location. Please try again later.");
        }
    }

    // Check if this IP is already registered for this user
    let userIp = await UserIp.findOne({ where: { userId, ipAddress: trimmedIp } });
    if (!userIp) {
        userIp = await UserIp.create({
            userId,
            ipAddress: trimmedIp,
            status: 'not approved'
        });
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, userIp, "IP address registered successfully. Status: not approved")
    );
});
