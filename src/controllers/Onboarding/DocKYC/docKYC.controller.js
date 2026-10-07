import User from '../../../models/User.js';
import Director from '../../../models/Director.js';
import sequelize from '../../../config/db.js';
import pkg from 'sequelize';
const { Op } = pkg;
import { uploadToR2 } from '../../../utils/r2Helper.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';
import { verifyPanCard, callVerificationApi } from '../../../utils/verificationHelper.js';
import logger from '../../../utils/logger.js';

/**
 * @desc    Signing authority auth & initiate DigiLocker session
 * @route   POST /api/onboarding/doc-kyc/signin-auth
 * @access  Private (User)
 */
export const signInAuth = asyncHandler(async (req, res) => {
    const { mobile, pep_status, fullName, email, pancard } = req.body;

    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    // Validate manual inputs from req.body
    if (!fullName || String(fullName).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "fullName is required.");
    }
    if (!email || String(email).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "email is required.");
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(email).trim())) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid email format.");
    }

    if (!pancard || String(pancard).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "pancard is required.");
    }
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(String(pancard).trim().toUpperCase())) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid PAN card format.");
    }

    // Validate required fields from body
    if (!mobile || String(mobile).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "mobile is required.");
    }
    if (!pep_status) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "pep_status is required.");
    }

    // Validate formats
    const mobileRegex = /^[0-9]{10}$/;
    if (!mobileRegex.test(String(mobile).trim())) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Mobile number must be exactly 10 digits.");
    }

    const validPepStatuses = ['Yes', 'No', 'Not Applicable'];
    const matchedStatus = validPepStatuses.find(
        status => status.toLowerCase() === String(pep_status).trim().toLowerCase()
    );
    if (!matchedStatus) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid pep_status. Must be one of: ${validPepStatuses.join(', ')}`);
    }

    // Check if mobile is already in use by another user
    const existingMobile = await User.findOne({
        where: {
            mobile: String(mobile).trim(),
            id: { [Op.ne]: userId }
        }
    });
    if (existingMobile) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Mobile number is already registered by another user.");
    }

    // Verify PAN card of the signing authority
    await verifyPanCard(pancard);

    const verifyUrl = process.env.DIGILOCKER_VERIFY_ACCOUNT_URL;
    const verifyData = await callVerificationApi(verifyUrl, { mobile_number: String(mobile).trim() }, "Failed to verify DigiLocker account status");

    // Determine if we need to redirect to sign up
    let redirectToSignup = false;
    if (verifyData && verifyData.code === 2002) {
        redirectToSignup = true;
    } else if (!verifyData || verifyData.code !== 1004) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Failed to verify DigiLocker account status.", [verifyData]);
    }

    // Generate unique orderId and temporarily save it in the user's columns atomically
    const orderId = `order_${Date.now()}_${userId}`;

    await sequelize.transaction(async (t) => {
        currentUser.digilocker_reference_key = orderId;
        currentUser.mobile = String(mobile).trim();
        currentUser.pep_status = matchedStatus;
        currentUser.authority_fullName = String(fullName).trim();
        currentUser.authority_pancard = String(pancard).trim().toUpperCase();
        currentUser.authority_email = String(email).trim().toLowerCase();
        currentUser.authority_pan_verification_status = 'verified';
        await currentUser.save({ transaction: t });
    });

    // Initiate DigiLocker Session
    const initUrl = process.env.DIGILOCKER_INITIATE_SESSION_URL;
    const initData = await callVerificationApi(initUrl, {
        redirect_url: process.env.DIGILOCKER_REDIRECT_URI,
        redirect_to_signup: redirectToSignup,
        consent: true,
        consent_purpose: "Verification for onboarding",
        state: orderId,
        documents_for_consent: ["ADHAR"]
    }, "Failed to initiate DigiLocker session");

    const authUrl = initData.url || initData.result?.url;

    if (!authUrl) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Failed to initiate DigiLocker session.", [initData]);
    }

    const successUrl = process.env.DIGILOCKER_SUCCESS_URI;

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                redirect_url: authUrl,
                successUrl: successUrl,
                user: {
                    id: currentUser.id,
                    fullName: currentUser.fullName,
                    email: currentUser.email,
                    mobile: currentUser.mobile,
                    pancard: currentUser.pancard,
                    pep_status: currentUser.pep_status,
                    orderId: orderId,
                    authority_fullName: currentUser.authority_fullName,
                    authority_pancard: currentUser.authority_pancard,
                    authority_email: currentUser.authority_email,
                    authority_pan_verification_status: currentUser.authority_pan_verification_status
                }
            },
            "Signing Authority details updated and DigiLocker session initiated successfully!"
        )
    );
});

/**
 * @desc    Verify and save business address details
 * @route   POST /api/onboarding/doc-kyc/verify-business-address
 * @access  Private (User)
 */
export const verifyBusinessAddress = asyncHandler(async (req, res) => {
    const {
        business_address,
        pincode,
        state,
        city,
        has_different_address,
        different_business_address,
        different_pincode,
        different_state,
        different_city
    } = req.body;

    const currentUser = await getAuthenticatedUser(req);

    // Validate primary business address fields
    if (!business_address || String(business_address).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "business_address is required.");
    }
    if (pincode === undefined || pincode === null || String(pincode).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "pincode is required.");
    }
    if (!state || String(state).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "state is required.");
    }
    if (!city || String(city).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "city is required.");
    }
    if (!has_different_address || String(has_different_address).trim() === "") {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "has_different_address (Yes/No) is required.");
    }

    // Validate pincode format
    const cleanPincode = String(pincode).trim();
    const pincodeRegex = /^[0-9]{6}$/;
    if (!pincodeRegex.test(cleanPincode)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Pincode must be exactly 6 digits.");
    }

    // Validate has_different_address options
    const validOptions = ['Yes', 'No'];
    const normalizedHasDifferent = validOptions.find(
        opt => opt.toLowerCase() === String(has_different_address).trim().toLowerCase()
    );
    if (!normalizedHasDifferent) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid has_different_address. Must be one of: ${validOptions.join(', ')}`);
    }

    let businessProofUrl = currentUser.business_proof_url;

    if (normalizedHasDifferent === 'Yes') {
        // Validate different address fields
        if (!different_business_address || String(different_business_address).trim() === "") {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "different_business_address is required when has_different_address is Yes.");
        }
        if (different_pincode === undefined || different_pincode === null || String(different_pincode).trim() === "") {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "different_pincode is required when has_different_address is Yes.");
        }
        if (!different_state || String(different_state).trim() === "") {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "different_state is required when has_different_address is Yes.");
        }
        if (!different_city || String(different_city).trim() === "") {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "different_city is required when has_different_address is Yes.");
        }

        const cleanDifferentPincode = String(different_pincode).trim();
        if (!pincodeRegex.test(cleanDifferentPincode)) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Different address pincode must be exactly 6 digits.");
        }

        // Validate document upload
        if (!req.file && !businessProofUrl) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Business address proof document file is required when has_different_address is Yes.");
        }

        // If file is provided, upload it to Cloudflare R2
        if (req.file) {
            const uploadResult = await uploadToR2(req.file.buffer, {
                folder: 'business_proof',
                publicId: `business_proof_${Date.now()}_${currentUser.id}`
            });
            businessProofUrl = uploadResult.secure_url;
        }
    }

    await sequelize.transaction(async (t) => {
        // Assign primary address details
        currentUser.business_address = String(business_address).trim();
        currentUser.business_pincode = Number(cleanPincode);
        currentUser.business_state = String(state).trim();
        currentUser.business_city = String(city).trim();
        currentUser.has_different_address = normalizedHasDifferent;

        if (normalizedHasDifferent === 'Yes') {
            const cleanDifferentPincode = String(different_pincode).trim();
            // Assign different address details
            currentUser.different_business_address = String(different_business_address).trim();
            currentUser.different_business_pincode = Number(cleanDifferentPincode);
            currentUser.different_business_state = String(different_state).trim();
            currentUser.different_business_city = String(different_city).trim();
            currentUser.business_proof_url = businessProofUrl;
        } else {
            // If No, duplicate the BusinessAddress details into different_BusinessAddress
            currentUser.different_business_address = currentUser.business_address;
            currentUser.different_business_pincode = currentUser.business_pincode;
            currentUser.different_business_state = currentUser.business_state;
            currentUser.different_business_city = currentUser.business_city;
        }

        await currentUser.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            id: currentUser.id,
            business_address: currentUser.business_address,
            business_pincode: currentUser.business_pincode,
            business_state: currentUser.business_state,
            business_city: currentUser.business_city,
            has_different_address: currentUser.has_different_address,
            different_business_address: currentUser.different_business_address,
            different_business_pincode: currentUser.different_business_pincode,
            different_business_state: currentUser.different_business_state,
            different_business_city: currentUser.different_business_city,
            business_proof_url: currentUser.business_proof_url
        }, "Business Address details successfully saved!")
    );
});

/**
 * @desc    Handle DigiLocker OAuth callback
 * @route   GET /public/api/digilocker/callback
 * @access  Public
 */
export const digilockerCallback = async (req, res) => {
    try {
        const { code, state } = req.query;
        const codeVerifier = req.query.codeVerifier || req.query.code_verifier;

        if (!code || !state) {
            return res.status(HTTP_STATUS.BAD_REQUEST).send("Callback parameters missing.");
        }

        // Find user matching state (orderId)
        const user = await User.findOne({
            where: { digilocker_reference_key: state }
        });

        if (!user) {
            return res.status(HTTP_STATUS.NOT_FOUND).send("User session not found.");
        }

        // Exchange code for reference_key
        const refUrl = process.env.DIGILOCKER_GET_REFERENCE_URL;
        const refData = await callVerificationApi(refUrl, { code, code_verifier: codeVerifier }, "Failed to retrieve reference key");

        if (!refData || !refData.reference_key) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(refData || { message: "Failed to retrieve reference key." });
        }

        const referenceKey = refData.reference_key;

        // Fetch Aadhaar XML/details from DigiLocker
        const aadhaarUrl = process.env.DIGILOCKER_FETCH_AADHAAR_URL;
        const aadhaarXml = await callVerificationApi(aadhaarUrl, { reference_key: referenceKey }, "Failed to fetch Aadhaar from DigiLocker");

        // Extract UID / Aadhaar number from XML using regex
        const uidMatch = aadhaarXml.match(/<UidData[^>]*uid=["']([^"']+)["']/i);
        const aadhaarNumber = uidMatch ? uidMatch[1] : null;

        // Save response data in database atomically
        await sequelize.transaction(async (t) => {
            user.authority_aadharcard = aadhaarNumber;
            user.digilocker_id = aadhaarNumber;
            user.digilocker_registered = 1;
            user.digilocker_reference_key = referenceKey; // Overwrite temp orderId with the real referenceKey
            user.digilocker_verified_at = new Date();
            user.digilocker_reference_expires_at = refData.expires_at ? new Date(refData.expires_at) : null;
            await user.save({ transaction: t });
        });

        // Redirect user's browser to the successUrl
        const successUrl = process.env.DIGILOCKER_SUCCESS_URI;
        return res.redirect(successUrl);

    } catch (error) {
        logger.error("DigiLocker Callback Error:", error);
        return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send("Error processing DigiLocker callback: " + error.message);
    }
};

/**
 * @desc    Upload Video KYC file for user verification
 * @route   POST /api/onboarding/doc-kyc/video-kyc
 * @access  Private (User)
 */
export const uploadVideoKYC = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);

    if (!req.file) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Please upload a video file.");
    }

    const result = await uploadToR2(req.file.buffer, {
        folder: 'video_kyc',
        publicId: `video_${Date.now()}_${currentUser.id}`
    });

    // Update the merchant_video field in the database atomically
    await sequelize.transaction(async (t) => {
        currentUser.merchant_video = result.secure_url;
        await currentUser.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                id: currentUser.id,
                fullName: currentUser.fullName,
                merchant_video: currentUser.merchant_video
            },
            "Video KYC uploaded and saved successfully!"
        )
    );
});