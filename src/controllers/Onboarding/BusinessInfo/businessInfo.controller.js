import dotenv from 'dotenv';
import User from '../../../models/User.js';
import Director from '../../../models/Director.js';
import sequelize from '../../../config/db.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';
import { verifyPanCard, verifyCinNumber, verifyGstNumber } from '../../../utils/verificationHelper.js';

dotenv.config();

/**
 * @desc    Verify NSDL PAN card for onboarding
 * @route   POST /api/onboarding/bussiness-info/verify-pan
 * @access  Private (User)
 */
export const verifyPan = asyncHandler(async (req, res) => {
    const { pan_number } = req.body;
    if (!pan_number) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "pan_number is required.");
    }

    const data = await verifyPanCard(pan_number);

    const currentUser = await getAuthenticatedUser(req);
    await sequelize.transaction(async (t) => {
        currentUser.fullName = data.full_name;
        currentUser.pancard = data.pan_number;
        currentUser.pan_verification_status = 'verified';
        await currentUser.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            fullName: data.full_name,
            pancard: data.pan_number,
            pan_verification_status: 'verified'
        }, "PAN card successfully verified!")
    );
});

/**
 * @desc    Verify CIN number and fetch company directors
 * @route   POST /api/onboarding/bussiness-info/verfiy-cin
 * @access  Private (User)
 */
export const verifyCin = asyncHandler(async (req, res) => {
    const { cin_number, expected_sales } = req.body;

    const currentUser = await getAuthenticatedUser(req);
    if (currentUser.pan_verification_status !== 'verified') {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. PAN verification must be completed first.");
    }
    if (!currentUser.business_type) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Business Type must be set first.");
    }
    if (!currentUser.business_category_id) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Business Category must be set first.");
    }

    // expected_sales is required for all business types
    if (expected_sales === undefined || expected_sales === null || String(expected_sales).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "expected_sales is required.");
    }

    await sequelize.transaction(async (t) => {
        currentUser.expected_sales = String(expected_sales).trim();
        await currentUser.save({ transaction: t });
    });

    // Skip CIN verification if business type is not Private Limited
    if (currentUser.business_type !== 'Private Limited') {
        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, { skipped: true, expected_sales: currentUser.expected_sales }, "expected_sales saved successfully. CIN verification is not required for this business type.")
        );
    }

    // Require cin_number for Private Limited
    if (!cin_number) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "cin_number (CIN) is required.");
    }

    const data = await verifyCinNumber(cin_number);

    if (data) {
        const oldCin = currentUser.cin;
        const newCin = data.details?.company_info?.cin || cin_number;

        await sequelize.transaction(async (t) => {
            if (oldCin && String(oldCin).trim().toUpperCase() !== String(newCin).trim().toUpperCase()) {
                // Delete all existing directors of this user as they belong to a different company
                await Director.destroy({
                    where: { userId: currentUser.id },
                    transaction: t
                });
            }

            currentUser.company_name = data.company_name || currentUser.company_name;
            currentUser.company_id = data.company_id || currentUser.company_id;
            currentUser.cin = newCin;
            currentUser.registered_address = data.details?.company_info?.registered_address || currentUser.registered_address;
            currentUser.company_category = data.details?.company_info?.company_category || currentUser.company_category;
            await currentUser.save({ transaction: t });
        });

        const cinVal = newCin;

        // Populate Director model table from data.details.directors
        if (data.details?.directors && Array.isArray(data.details.directors)) {
            // Deduplicate directors array from the API response based on din_number
            const uniqueApiDirectors = [];
            const seenDins = new Set();
            for (const dir of data.details.directors) {
                const din = dir.din_number ? String(dir.din_number).trim() : null;
                if (din && !seenDins.has(din)) {
                    seenDins.add(din);
                    uniqueApiDirectors.push(dir);
                }
            }

            const dinNumbers = uniqueApiDirectors
                .map(dir => String(dir.din_number).trim());

            const existingDirs = await Director.findAll({
                where: {
                    userId: currentUser.id,
                    din_number: dinNumbers
                }
            });

            const existingDirMap = new Map();
            existingDirs.forEach(dir => {
                existingDirMap.set(dir.din_number, dir);
            });

            await sequelize.transaction(async (t) => {
                for (const dir of uniqueApiDirectors) {
                    const din = String(dir.din_number).trim();
                    const existingDir = existingDirMap.get(din);

                    if (existingDir) {
                        existingDir.director_name = dir.director_name || existingDir.director_name;
                        existingDir.surrendered_din = dir.surrendered_din || existingDir.surrendered_din;
                        existingDir.cin = cinVal || existingDir.cin;
                        existingDir.doj = dir.start_date || existingDir.doj;
                        await existingDir.save({ transaction: t });
                    } else {
                        const newDir = await Director.create({
                            userId: currentUser.id,
                            director_name: dir.director_name || "Unknown Director",
                            pancard: null,
                            dob: null,
                            din_number: din,
                            doj: dir.start_date || null,
                            surrendered_din: dir.surrendered_din || 'No',
                            cin: cinVal || null
                        }, { transaction: t });
                        // Add newly created director to existingDirMap so concurrent duplicates in same batch aren't recreated
                        existingDirMap.set(din, newDir);
                    }
                }
            });
        }

        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, {
                company_name: currentUser.company_name,
                company_id: currentUser.company_id,
                cin: currentUser.cin,
                registered_address: currentUser.registered_address,
                company_category: currentUser.company_category
            }, "CIN successfully verified and directors list populated!")
        );
    }
});

/**
 * @desc    Verify GST number for onboarding
 * @route   POST /api/onboarding/bussiness-info/verify-gst
 * @access  Private (User)
 */
export const verifyGst = asyncHandler(async (req, res) => {
    const { gst_number } = req.body;
    if (!gst_number) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "gst_number is required.");
    }

    const currentUser = await getAuthenticatedUser(req);
    if (currentUser.pan_verification_status !== 'verified') {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. PAN verification must be completed first.");
    }
    if (!currentUser.business_type) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Business Type must be set first.");
    }
    if (!currentUser.business_category_id) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Business Category must be set first.");
    }

    const data = await verifyGstNumber(gst_number);

    if (data) {
        const taxpayer = data.result?.taxpayer_details || {};

        await sequelize.transaction(async (t) => {
            currentUser.gst_number = taxpayer.gst_number || gst_number;
            currentUser.gst_legal_name = taxpayer.legal_name || null;
            await currentUser.save({ transaction: t });
        });

        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, {
                gst_number: currentUser.gst_number,
                gst_legal_name: currentUser.gst_legal_name
            }, "GST successfully verified!")
        );
    }
});

/**
 * @desc    Update business type for user
 * @route   PATCH /api/onboarding/bussiness-info/update-business-type
 * @access  Private (User)
 */
export const updateBusinessType = asyncHandler(async (req, res) => {
    const { business_type } = req.body;
    if (!business_type) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "business_type is required.");
    }

    let normalized = String(business_type).trim();
    const lowerVal = normalized.toLowerCase();
    if (lowerVal === 'proprietorship') {
        normalized = 'Proprietorship';
    } else if (lowerVal === 'private limited') {
        normalized = 'Private Limited';
    } else if (lowerVal === 'partnership') {
        normalized = 'Partnership';
    } else if (lowerVal === 'huf') {
        normalized = 'HUF';
    } else if (lowerVal === 'trust') {
        normalized = 'Trust';
    } else if (lowerVal === 'unicorpass') {
        normalized = 'UnicorpAss';
    }

    const validTypes = ['Private Limited', 'Proprietorship', 'Partnership', 'HUF', 'Trust', 'UnicorpAss'];
    if (!validTypes.includes(normalized)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid business type. Must be one of: ${validTypes.join(', ')}`);
    }

    const user = await getAuthenticatedUser(req);

    if (user.pan_verification_status !== 'verified') {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. You must successfully complete PAN verification before setting your Business Type.");
    }

    await sequelize.transaction(async (t) => {
        user.business_type = normalized;
        if (normalized !== 'Private Limited') {
            user.cin = null;
            user.company_name = null;
            user.company_id = null;
            user.registered_address = null;
            user.company_category = null;
        }
        await user.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                id: user.id,
                fullName: user.fullName,
                email: user.email,
                business_type: user.business_type
            },
            "Business type successfully updated!"
        )
    );
});

/**
 * @desc    Update business category for user
 * @route   PATCH /api/onboarding/bussiness-info/update-business-category
 * @access  Private (User)
 */
export const updateBusinessCategory = asyncHandler(async (req, res) => {
    const { business_category } = req.body;
    if (!business_category) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "business_category is required.");
    }

    const user = await getAuthenticatedUser(req);

    if (user.pan_verification_status !== 'verified') {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. You must successfully complete PAN verification before setting your Business Category.");
    }

    if (!user.business_type) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. You must set your Business Type before setting your Business Category.");
    }

    await sequelize.transaction(async (t) => {
        user.business_category = business_category;
        await user.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                id: user.id,
                fullName: user.fullName,
                email: user.email,
                business_type: user.business_type,
                business_category: user.business_category,
                business_category_id: user.business_category_id
            },
            "Business category successfully updated!"
        )
    );
});

/**
 * @desc    Update business URLs (Website/App/iOS)
 * @route   PATCH /api/onboarding/bussiness-info/update-business-urls
 * @access  Private (User)
 */
export const updateBusinessUrls = asyncHandler(async (req, res) => {
    const { business_url, app_url, ios_url } = req.body;

    const user = await getAuthenticatedUser(req);

    if (user.pan_verification_status !== 'verified') {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. PAN verification must be completed first.");
    }
    if (!user.business_type) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Business Type must be set first.");
    }
    if (!user.business_category_id) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. Business Category must be set first.");
    }
    if (user.business_type === 'Private Limited' && !user.cin) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, "Access Denied. CIN verification must be completed first for Private Limited business type.");
    }

    await sequelize.transaction(async (t) => {
        if (business_url !== undefined) user.business_url = business_url;
        if (app_url !== undefined) user.app_url = app_url;
        if (ios_url !== undefined) user.ios_url = ios_url;
        await user.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                id: user.id,
                fullName: user.fullName,
                business_url: user.business_url,
                app_url: user.app_url,
                ios_url: user.ios_url
            },
            "Business URLs successfully updated!"
        )
    );
});

/**
 * @desc    Update current KYC onboarding step and category
 * @route   PATCH /api/onboarding/bussiness-info/update-kyc-step
 * @access  Private (User)
 */
export const updateKycStep = asyncHandler(async (req, res) => {
    const { kyc_step, kyc_category } = req.body;

    if (kyc_step === undefined || kyc_step === null || kyc_step === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "kyc_step is required.");
    }
    if (!kyc_category) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "kyc_category is required.");
    }

    const validCategories = ['Business', 'KYC_Checks', 'Director', 'Ubos', 'Documents', 'Bank_Info'];
    if (!validCategories.includes(kyc_category)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid kyc_category. Must be one of: ${validCategories.join(', ')}`);
    }

    const user = await getAuthenticatedUser(req);

    const parsedStep = parseInt(kyc_step, 10);
    if (isNaN(parsedStep)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "kyc_step must be a valid integer.");
    }

    await sequelize.transaction(async (t) => {
        user.kyc_step = parsedStep;
        user.kyc_category = kyc_category;
        await user.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                id: user.id,
                fullName: user.fullName,
                kyc_step: user.kyc_step,
                kyc_category: user.kyc_category
            },
            "KYC step and category successfully updated!"
        )
    );
});


