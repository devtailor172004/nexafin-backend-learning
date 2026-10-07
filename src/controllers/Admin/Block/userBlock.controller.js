import sequelize from '../../../config/db.js';
import User from '../../../models/User.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';

/**
 * @desc    Block or unblock a user strictly by UUID (Admin)
 * @route   PATCH /api/admin/block/users/:uuid
 * @access  Private (Admin)
 */
export const updateUserBlockStatus = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    let { is_blocked } = req.body;

    if (typeof is_blocked === 'string') {
        if (is_blocked.trim().toLowerCase() === 'true') {
            is_blocked = true;
        } else if (is_blocked.trim().toLowerCase() === 'false') {
            is_blocked = false;
        }
    }

    if (is_blocked === undefined || typeof is_blocked !== 'boolean') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "is_blocked field is required and must be a boolean value ('true' or 'false').");
    }

    // Find user strictly by UUID
    const user = await User.findOne({
        where: { uuid }
    });

    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    // Prevent blocking the admin itself
    if (user.role === 'Admin' && is_blocked) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Admin user cannot be blocked.");
    }

    await sequelize.transaction(async (t) => {
        user.is_blocked = is_blocked;
        await user.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                uuid: user.uuid,
                fullName: user.fullName,
                email: user.email,
                is_blocked: user.is_blocked
            },
            `User has been successfully ${is_blocked ? 'blocked' : 'unblocked'}.`
        )
    );
});