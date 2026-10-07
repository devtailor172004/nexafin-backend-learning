import User from '../../../models/User.js';
import { uploadToR2 } from '../../../utils/r2Helper.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';

// Generic helper function for document uploads
const handleDocumentUpload = async (req, res, urlField, docName) => {
    const currentUser = await getAuthenticatedUser(req);

    if (!req.file) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Please upload a ${docName} file.`);
    }

    const uploadResult = await uploadToR2(req.file.buffer, {
        folder: 'documentUpload',
        publicId: `doc_${Date.now()}_${currentUser.id}`
    });

    currentUser[urlField] = uploadResult.secure_url;
    await currentUser.save();

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, { url: uploadResult.secure_url }, `${docName} uploaded successfully!`)
    );
};

/**
 * @desc    Upload PAN card document
 * @route   POST /api/onboarding/document-upload/pan
 * @access  Private (User)
 */
export const panUpload = asyncHandler((req, res) => handleDocumentUpload(req, res, 'pan_card_url', 'PAN card'));

/**
 * @desc    Upload Aadhaar card document
 * @route   POST /api/onboarding/document-upload/aadhar
 * @access  Private (User)
 */
export const aadharcardUpload = asyncHandler((req, res) => handleDocumentUpload(req, res, 'aadhar_card_url', 'Aadhaar card'));

/**
 * @desc    Upload Business proof document
 * @route   POST /api/onboarding/document-upload/business-proof
 * @access  Private (User)
 */
export const businessProofUpload = asyncHandler((req, res) => handleDocumentUpload(req, res, 'business_proof_url', 'Business proof'));
