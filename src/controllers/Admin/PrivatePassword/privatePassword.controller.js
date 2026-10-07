import bcrypt from 'bcryptjs';
import AdminSetting from '../../../models/AdminSetting.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';

/**
 * @desc    Update or set the KYC private password (Admin)
 * @route   POST /api/admin/private-password
 * @access  Private (Admin)
 */
export const updatePrivatePassword = asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password || String(password).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Password is required.");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save or update key 'kyc_private_password'
    const [setting, created] = await AdminSetting.findOrCreate({
        where: { key: 'kyc_private_password' },
        defaults: { value: hashedPassword }
    });

    if (!created) {
        setting.value = hashedPassword;
        await setting.save();
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {}, "Private password for KYC updates successfully saved.")
    );
});
