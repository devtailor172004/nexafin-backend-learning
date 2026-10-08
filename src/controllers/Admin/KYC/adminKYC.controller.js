import pkg from 'sequelize';
const { Op } = pkg;
import bcrypt from 'bcryptjs';
import sequelize from '../../../config/db.js';
import Director from '../../../models/Director.js';
import User from '../../../models/User.js';
import UserDocument from '../../../models/UserDocument.js';
import AdminSetting from '../../../models/AdminSetting.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getPaginationParams, formatPaginatedResponse } from '../../../utils/paginationHelper.js';
import { getOrCreateUserProducts } from '../Product/product.controller.js';
import { getKycJourneyForUser } from '../../../securepay/kycJourney.js';

/**
 * @desc    Get KYC profiles list filtered by status (Admin)
 * @route   GET /api/admin/kyc
 * @access  Private (Admin)
 */
export const getKycProfiles = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 10, name, mobile } = req.query;
    const { pageNum, limitNum, offset } = getPaginationParams(page, limit);

    // Safe formatting to capitalized ENUM format (e.g. 'Pending') or default to 'Pending'
    let targetStatus = 'Pending';
    if (status && typeof status === 'string') {
        targetStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    }

    const whereClause = {
        [Op.and]: [
            { kyc: targetStatus }
        ]
    };

    if (name) {
        whereClause[Op.and].push({
            fullName: {
                [Op.like]: `%${String(name).trim()}%`
            }
        });
    }

    if (mobile) {
        whereClause[Op.and].push({
            mobile: {
                [Op.like]: `%${String(mobile).trim()}%`
            }
        });
    }

    const { count, rows: users } = await User.findAndCountAll({
        where: whereClause,
        attributes: ['id', 'uuid', 'fullName', 'email', 'mobile', 'business_type', 'kyc', 'updatedAt', 'createdAt'],
        limit: limitNum,
        offset: offset,
        order: [['updatedAt', 'DESC']]
    });

    const responseData = formatPaginatedResponse(count, users, pageNum, limitNum, 'users');

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, responseData, `KYC profiles with status '${targetStatus}' fetched successfully.`)
    );
});

/**
 * @desc    Get complete KYC profile details of a user including directors strictly by UUID (Admin)
 * @route   GET /api/admin/kyc/:uuid
 * @access  Private (Admin)
 */
export const getKycProfileById = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const user = await User.findOne({
        where: { uuid },
        attributes: { exclude: ['password'] }
    });

    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    // Fetch associated directors/partners
    let whereClause = {};
    if (user.business_type === 'Private Limited' && user.cin) {
        whereClause = { cin: user.cin };
    } else {
        whereClause = { userId: user.id };
    }

    const directors = await Director.findAll({
        where: whereClause,
        order: [['createdAt', 'ASC']]
    });

    // Ensure products exist and fetch them
    const products = await getOrCreateUserProducts(user.id);

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, { user, directors, products }, "User KYC profile details fetched successfully.")
    );
});

/**
 * @desc    Approve or Reject a user's KYC status strictly by UUID (Admin)
 * @route   PUT /api/admin/kyc/:uuid/status
 * @access  Private (Admin)
 */
export const updateKycStatus = asyncHandler(async (req, res) => {
    const {uuid} = req.params;
    const { status, reason, private_password } = req.body;

    // Verify KYC private password
    const setting = await AdminSetting.findOne({ where: { key: 'kyc_private_password' } });
    if (!setting) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "KYC private password has not been set by the admin yet.");
    }

    if (!private_password || String(private_password).trim() === "") {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Private password is required to update KYC status.");
    }

    const isMatch = await bcrypt.compare(private_password, setting.value);
    if (!isMatch) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Invalid private password. Access denied.");
    }

    if (!status || !['approved', 'rejected', 'pending'].includes(status.toLowerCase())) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Status is required and must be either 'Pending', 'Approved', or 'Rejected'.");
    }

    const user = await User.findOne({ where: { uuid } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    // Format to capitalized ENUM format: Pending, Approved, Rejected
    const targetStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

    await sequelize.transaction(async (t) => {
        user.kyc = targetStatus;

        if (targetStatus === 'Rejected') {
            if (!reason || String(reason).trim() === "") {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Rejection reason is required when status is 'rejected'.");
            }
            user.kyc_rejection_reason = String(reason).trim();
        } else {
            user.kyc_rejection_reason = null;
        }

        await user.save({ transaction: t });

        if (targetStatus === 'Approved') {
            await getOrCreateUserProducts(user.id, t);
        }
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                id: user.id,
                uuid: user.uuid,
                fullName: user.fullName,
                kyc: user.kyc,
                kyc_rejection_reason: user.kyc_rejection_reason
            },
            `User KYC status updated to '${targetStatus}' successfully!`
        )
    );
});

/**
 * Verifies the KYC private password kept in admin_settings.
 * Shared by every admin action that can change KYC state.
 */
const assertKycPrivatePassword = async (private_password) => {
    const setting = await AdminSetting.findOne({ where: { key: 'kyc_private_password' } });
    if (!setting) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "KYC private password has not been set by the admin yet.");
    }
    if (!private_password || String(private_password).trim() === "") {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Private password is required to update KYC state.");
    }
    const isMatch = await bcrypt.compare(String(private_password), setting.value);
    if (!isMatch) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Invalid private password. Access denied.");
    }
};

/**
 * @desc    Full KYC journey (steps, blockers, completion) for a merchant
 * @route   GET /api/admin/kyc/:uuid/journey
 * @access  Private (Admin)
 */
export const getKycJourney = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const user = await User.findOne({ where: { uuid } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    const journey = await getKycJourneyForUser(user);

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            user: { id: user.id, uuid: user.uuid, fullName: user.fullName, email: user.email, mobile: user.mobile },
            ...journey
        }, "KYC journey fetched successfully.")
    );
});

/**
 * @desc    Approve or reject a single uploaded KYC document
 * @route   PATCH /api/admin/kyc/:uuid/documents/:documentUuid/status
 * @access  Private (Admin)
 */
export const reviewUserDocument = asyncHandler(async (req, res) => {
    const { uuid, documentUuid } = req.params;
    const { status, reason, private_password } = req.body;

    await assertKycPrivatePassword(private_password);

    const normalized = String(status || '').toLowerCase();
    if (!['verified', 'rejected', 'pending'].includes(normalized)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Status must be one of: verified, rejected, pending.");
    }

    if (normalized === 'rejected' && (!reason || String(reason).trim() === '')) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "A rejection reason is required when rejecting a document.");
    }

    const user = await User.findOne({ where: { uuid } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    const document = await UserDocument.findOne({ where: { uuid: documentUuid, userId: user.id } });
    if (!document) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Document not found for this user.");
    }

    document.status = normalized;
    document.rejection_reason = normalized === 'rejected' ? String(reason).trim() : null;
    await document.save();

    const journey = await getKycJourneyForUser(user);

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            document: {
                uuid: document.uuid,
                document_type: document.document_type,
                status: document.status,
                rejection_reason: document.rejection_reason
            },
            journey
        }, `Document marked as '${normalized}'.`)
    );
});