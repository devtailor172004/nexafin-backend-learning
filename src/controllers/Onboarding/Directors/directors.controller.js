import pkg from 'sequelize';
const { Op } = pkg;
import User from '../../../models/User.js';
import Director from '../../../models/Director.js';
import sequelize from '../../../config/db.js';
import { uploadToR2 } from '../../../utils/r2Helper.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { validateAadharFormat, validatePanFormat, validateDateFormat, compareNames } from '../../../utils/validationHelper.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';
import { verifyPanCard } from '../../../utils/verificationHelper.js';
import crypto from 'crypto';

// Helper to build whereClause for finding directors based on business type
const getDirectorWhereClause = (currentUser, req) => {
    let whereClause = {};
    if (currentUser.business_type === 'Private Limited') {
        const { cin_number } = { ...req.query, ...req.body };
        if (!cin_number || String(cin_number).trim() === "") {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "cin_number is required for Private Limited business type.");
        }
        whereClause = { cin: String(cin_number).trim() };
    } else {
        whereClause = { userId: currentUser.id };
    }
    return whereClause;
};

/**
 * @desc    Get director list and update partnership percentages
 * @route   GET/POST /api/onboarding/directors/directors
 * @access  Private (User)
 */
export const getDirectorList = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);

    const whereClause = getDirectorWhereClause(currentUser, req);

    const { has_more_than_10_percent_partnership, directors, aadharcard } = { ...req.query, ...req.body };

    if (has_more_than_10_percent_partnership !== undefined) {
        let hasPartnership = null;
        const val = String(has_more_than_10_percent_partnership).trim().toLowerCase();
        if (val === 'yes') hasPartnership = 'Yes';
        else if (val === 'no') hasPartnership = 'No';
        else {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "has_more_than_10_percent_partnership must be either 'Yes' or 'No'.");
        }

        if (hasPartnership === 'Yes') {
            let directorsList = [];
            if (typeof directors === 'string') {
                try {
                    directorsList = JSON.parse(directors);
                } catch (e) {
                    throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid format for directors array.");
                }
            } else if (Array.isArray(directors)) {
                directorsList = directors;
            }

            if (!directorsList || directorsList.length === 0) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Please enter partnership percentage for directors.");
            }

            const directorIds = directorsList.map(item => item.id);
            const dbDirectors = await Director.findAll({
                where: {
                    id: directorIds,
                    ...whereClause
                }
            });

            const directorMap = new Map(dbDirectors.map(d => [d.id, d]));

            for (const item of directorsList) {
                const dirId = item.id;
                const pct = parseFloat(item.partnership_percentage);
                if (isNaN(pct) || pct < 0 || pct > 100) {
                    throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid partnership_percentage for director ID ${dirId}. Must be between 0 and 100.`);
                }

                const directorObj = directorMap.get(dirId);
                if (!directorObj) {
                    throw new ApiError(HTTP_STATUS.NOT_FOUND, `Director with ID ${dirId} not found under your company profile.`);
                }

                let inputAadhar = item.aadharcard || item.aadharcard_number;
                if (inputAadhar === undefined && aadharcard !== undefined) {
                    inputAadhar = aadharcard;
                }
                if (inputAadhar !== undefined) {
                    if (inputAadhar) {
                        directorObj.aadharcard = validateAadharFormat(inputAadhar, directorObj.director_name);
                        directorObj.aadharcard_verification_status = 'verified';
                    } else {
                        directorObj.aadharcard = null;
                        directorObj.aadharcard_verification_status = 'pending';
                    }
                }
                // If partnership percentage > 10%, PAN must be verified first, then Aadhaar card number and documents are required
                if (pct > 10) {
                    if (directorObj.pan_verification_status !== 'verified') {
                        throw new ApiError(
                            HTTP_STATUS.BAD_REQUEST,
                            `Director '${directorObj.director_name}' has partnership percentage ${pct}% (> 10%), so PAN card verification is required first. Please call POST /verify-director-pan API to verify this director's PAN.`
                        );
                    }
                    if (!directorObj.aadharcard || String(directorObj.aadharcard).trim() === "") {
                        throw new ApiError(
                            HTTP_STATUS.BAD_REQUEST,
                            `Director '${directorObj.director_name}' has partnership percentage ${pct}% (> 10%), so Aadhaar card number is required. Please provide Aadhaar card number.`
                        );
                    }
                    if (!directorObj.aadharcard_front_url || String(directorObj.aadharcard_front_url).trim() === "") {
                        throw new ApiError(
                            HTTP_STATUS.BAD_REQUEST,
                            `Director '${directorObj.director_name}' has partnership percentage ${pct}% (> 10%), so Aadhaar card front image is required. Please upload and provide aadharcard_front_url.`
                        );
                    }
                    if (!directorObj.aadharcard_back_url || String(directorObj.aadharcard_back_url).trim() === "") {
                        throw new ApiError(
                            HTTP_STATUS.BAD_REQUEST,
                            `Director '${directorObj.director_name}' has partnership percentage ${pct}% (> 10%), so Aadhaar card back image is required. Please upload and provide aadharcard_back_url.`
                        );
                    }
                    if (!directorObj.pancard_url || String(directorObj.pancard_url).trim() === "") {
                        throw new ApiError(
                            HTTP_STATUS.BAD_REQUEST,
                            `Director '${directorObj.director_name}' has partnership percentage ${pct}% (> 10%), so PAN card image is required. Please upload and provide pancard_url.`
                        );
                    }
                }

                directorObj.partnership_percentage = pct;
            }

            // Save updates in a single transaction
            await sequelize.transaction(async (t) => {
                await Promise.all(dbDirectors.map(d => d.save({ transaction: t })));
                currentUser.has_more_than_10_percent_partnership = hasPartnership;
                await currentUser.save({ transaction: t });
            });

            // Verify that the total sum of all directors' partnership percentages does not exceed 100%
            const allDirs = await Director.findAll({ where: whereClause });
            let totalPercentage = 0;
            for (const d of allDirs) {
                totalPercentage += parseFloat(d.partnership_percentage || 0);
            }

            if (totalPercentage > 100) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Total partnership percentage of all directors cannot exceed 100%. Current total: ${totalPercentage}%.`);
            }
        } else {
            // If No, clear all partnership percentages inside an atomic transaction
            await sequelize.transaction(async (t) => {
                const allDirs = await Director.findAll({ where: whereClause, transaction: t });
                for (const d of allDirs) {
                    d.partnership_percentage = null;
                    await d.save({ transaction: t });
                }
                currentUser.has_more_than_10_percent_partnership = hasPartnership;
                await currentUser.save({ transaction: t });
            });
        }
    }

    const directorsResult = await Director.findAll({
        where: whereClause,
        order: [['createdAt', 'ASC']]
    });

    let totalPartnershipPercentage = 0;
    for (const d of directorsResult) {
        totalPartnershipPercentage += parseFloat(d.partnership_percentage || 0);
    }

    // Ensure all directors have a UUID. If any is missing, generate and save in parallel.
    const missingUuidDirs = directorsResult.filter(d => !d.uuid);
    if (missingUuidDirs.length > 0) {
        await Promise.all(missingUuidDirs.map(d => {
            d.uuid = crypto.randomUUID();
            return d.save();
        }));
    }

    const directorsMap = {};
    for (const d of directorsResult) {
        directorsMap[d.director_name] = {
            id: d.id,
            uuid: d.uuid,
            userId: d.userId,
            director_name: d.director_name,
            pancard: d.pancard,
            pan_verification_status: d.pan_verification_status,
            aadharcard: d.aadharcard,
            aadharcard_verification_status: d.aadharcard_verification_status,
            digilocker_reference_key: d.digilocker_reference_key,
            dob: d.dob,
            din_number: d.din_number,
            doj: d.doj,
            surrendered_din: d.surrendered_din,
            cin: d.cin,
            partnership_percentage: d.partnership_percentage,
            aadharcard_front_url: d.aadharcard_front_url,
            aadharcard_back_url: d.aadharcard_back_url,
            pancard_url: d.pancard_url,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt
        };
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            has_more_than_10_percent_partnership: currentUser.has_more_than_10_percent_partnership,
            total_partnership_percentage: parseFloat(totalPartnershipPercentage.toFixed(2)),
            directors: directorsMap
        }, "Directors list successfully fetched!")
    );
});

/**
 * @desc    Add a new director manually for Proprietorship or Partnership
 * @route   POST /api/onboarding/directors/add-director
 * @access  Private (User)
 */
export const addDirector = asyncHandler(async (req, res) => {
    const { director_name, pancard, aadharcard, dob, din_number, doj, surrendered_din, aadharcard_front_url, aadharcard_back_url, pancard_url } = req.body;

    if (!director_name) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "director_name is required.");
    }

    const user = await getAuthenticatedUser(req);
    const userId = user.id;

    if (user.business_type !== 'Proprietorship' && user.business_type !== 'Partnership') {
        throw new ApiError(
            HTTP_STATUS.FORBIDDEN,
            "Access Denied. Manual director entry is only allowed for 'Proprietorship' or 'Partnership' business types."
        );
    }

    let finalDin = null;
    if (din_number !== undefined && din_number !== null && String(din_number).trim() !== "") {
        const trimmedDin = String(din_number).trim();
        if (trimmedDin.length !== 8 || isNaN(parseInt(trimmedDin, 10))) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "DIN number must be exactly 8 digits.");
        }

        const existingDirector = await Director.findOne({ where: { din_number: trimmedDin } });
        if (existingDirector) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "A director with this DIN number already exists.");
        }
        finalDin = trimmedDin;
    } else {
        // Autogenerate unique 8-digit DIN number
        let exists = true;
        let attempts = 0;
        const maxAttempts = 10;
        while (exists && attempts < maxAttempts) {
            finalDin = String(Math.floor(10000000 + Math.random() * 90000000));
            const count = await Director.count({ where: { din_number: finalDin } });
            if (count === 0) {
                exists = false;
            }
            attempts++;
        }
        if (exists) {
            throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, "Failed to auto-generate a unique DIN number. Please enter one manually or try again.");
        }
    }

    // Validate PAN format if provided
    if (pancard) {
        validatePanFormat(pancard);
    }

    // Validate Aadhaar format if provided
    if (aadharcard) {
        validateAadharFormat(aadharcard);
    }

    // Validate DOB format if provided
    let cleanDob = null;
    if (dob) {
        cleanDob = validateDateFormat(dob, "Date of Birth (dob)");
    }

    const newDirector = await sequelize.transaction(async (t) => {
        return await Director.create({
            userId,
            director_name,
            pancard: pancard ? String(pancard).trim().toUpperCase() : null,
            aadharcard: aadharcard ? String(aadharcard).trim() : null,
            aadharcard_verification_status: aadharcard ? 'verified' : 'pending',
            dob: cleanDob,
            din_number: finalDin,
            doj,
            surrendered_din: surrendered_din || 'No',
            aadharcard_front_url: aadharcard_front_url ? String(aadharcard_front_url).trim() : null,
            aadharcard_back_url: aadharcard_back_url ? String(aadharcard_back_url).trim() : null,
            pancard_url: pancard_url ? String(pancard_url).trim() : null
        }, { transaction: t });
    });

    return res.status(HTTP_STATUS.CREATED).json(
        new ApiResponse(HTTP_STATUS.CREATED, newDirector, "Director successfully added!")
    );
});

/**
 * @desc    Update a director details strictly by UUID
 * @route   PATCH /api/onboarding/directors/update-director/:uuid
 * @access  Private (User)
 */
export const updateDirector = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { pancard, dob } = req.body;

    const userId = req.user?.id;
    if (!userId) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Access Denied. Authentication required.");
    }

    if (!uuid || uuid === "undefined" || uuid === "null") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Valid director UUID is required.");
    }

    const director = await Director.findOne({
        where: {
            uuid: String(uuid),
            userId
        }
    });

    if (!director) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Director not found or access denied.");
    }

    await sequelize.transaction(async (t) => {
        // Validate and update pancard
        if (pancard !== undefined) {
            if (pancard) {
                const cleanPan = validatePanFormat(pancard);
                if (director.pancard !== cleanPan) {
                    director.pancard = cleanPan;
                    director.pan_verification_status = 'pending';
                    director.aadharcard_verification_status = 'pending';
                }
            } else {
                if (director.pancard !== null) {
                    director.pancard = null;
                    director.pan_verification_status = 'pending';
                    director.aadharcard_verification_status = 'pending';
                }
            }
        }

        // Validate and update dob
        if (dob !== undefined) {
            if (dob) {
                director.dob = validateDateFormat(dob, "Date of Birth (dob)");
            } else {
                director.dob = null;
            }
        }

        await director.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, director, "Director successfully updated!")
    );
});

/**
 * @desc    Verify PAN card of a director
 * @route   POST /api/onboarding/directors/verify-director-pan
 * @access  Private (User)
 */
export const verifyDirectorPan = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);

    const { director_id, pancard } = { ...req.body, ...req.params };

    if (!director_id) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "director_id is required.");
    }
    if (!pancard || String(pancard).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "pancard is required.");
    }

    // Validate PAN format
    const cleanPan = validatePanFormat(pancard);

    // Build whereClause same as getDirectorList
    const whereClause = getDirectorWhereClause(currentUser, req);

    // Find director under the user/company (support numeric ID or UUID)
    const isNumericId = !isNaN(director_id) && !String(director_id).includes('-');
    const director = await Director.findOne({
        where: {
            [Op.or]: [
                { id: isNumericId ? Number(director_id) : -1 },
                { uuid: String(director_id) }
            ],
            ...whereClause
        }
    });

    if (!director) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, `Director with ID/UUID '${director_id}' not found under your company profile.`);
    }

    // Call centralized PAN verification
    const panData = await verifyPanCard(cleanPan);

    // Verify that the name returned by PAN matches the registered director_name
    const isMatch = compareNames(director.director_name, panData.full_name);

    if (!isMatch) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `PAN verification name mismatch. The name on this PAN card ('${panData.full_name || 'N/A'}') does not match the director's registered name ('${director.director_name}').`
        );
    }

    // Save verified PAN, status and DOB (if returned) atomically
    await sequelize.transaction(async (t) => {
        director.pancard = cleanPan;
        director.pan_verification_status = 'verified';

        if (panData.dob) {
            const cleanDobStr = String(panData.dob).trim();
            let formattedDob = null;

            // Match YYYY-MM-DD
            if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(cleanDobStr)) {
                formattedDob = cleanDobStr;
            } else {
                // Try to match DD/MM/YYYY or DD-MM-YYYY
                const dmyRegex = /^(\d{2})[/-](\d{2})[/-](\d{4})$/;
                const match = cleanDobStr.match(dmyRegex);
                if (match) {
                    const [_, day, month, year] = match;
                    const parsedDate = `${year}-${month}-${day}`;
                    if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(parsedDate)) {
                        formattedDob = parsedDate;
                    }
                }
            }

            if (formattedDob) {
                director.dob = formattedDob;
            }
        }

        await director.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            id: director.id,
            uuid: director.uuid,
            director_name: director.director_name,
            pancard: director.pancard,
            pan_verification_status: director.pan_verification_status,
            dob: director.dob,
            partnership_percentage: director.partnership_percentage
        }, `PAN card successfully verified for director '${director.director_name}'.`)
    );
});

/**
 * @desc    Upload Director Document (Aadhaar Front/Back, PAN)
 * @route   POST /api/onboarding/directors/upload-document
 * @access  Private (User)
 */
export const uploadDirectorDocument = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);

    const { director_id, document_type } = { ...req.query, ...req.body };

    if (!director_id) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "director_id is required.");
    }
    if (!document_type) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "document_type is required.");
    }

    // Validate document_type
    const validDocumentTypes = ['aadharcard_front', 'aadharcard_back', 'pancard'];
    if (!validDocumentTypes.includes(document_type)) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `Invalid document_type: "${document_type}". Must be one of: ${validDocumentTypes.join(', ')}`
        );
    }

    if (!req.file) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Please upload a file.");
    }

    // Build whereClause to verify ownership of director
    const whereClause = getDirectorWhereClause(currentUser, req);

    // Find the director under current company/user (support numeric ID or UUID)
    const isNumericDocDirId = !isNaN(director_id) && !String(director_id).includes('-');
    const director = await Director.findOne({
        where: {
            [Op.or]: [
                { id: isNumericDocDirId ? Number(director_id) : -1 },
                { uuid: String(director_id) }
            ],
            ...whereClause
        }
    });

    if (!director) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, `Director with ID/UUID '${director_id}' not found under your company profile.`);
    }

    // Upload file to Cloudflare R2
    const safeDocType = document_type.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const uploadResult = await uploadToR2(req.file.buffer, {
        folder: 'director_documents',
        publicId: `director_${director_id}_${safeDocType}_${Date.now()}`
    });

    // Save corresponding URL atomically
    const urlField = `${document_type}_url`;
    await sequelize.transaction(async (t) => {
        director[urlField] = uploadResult.secure_url;
        await director.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            id: director.id,
            uuid: director.uuid,
            director_name: director.director_name,
            document_type,
            url: uploadResult.secure_url
        }, `Director document '${document_type}' successfully uploaded!`)
    );
});
