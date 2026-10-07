import User from '../../../models/User.js';
import UserDocument from '../../../models/UserDocument.js';
import { uploadToR2 } from '../../../utils/r2Helper.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';
import {
    BUSINESS_TYPE_DOCUMENTS,
    COMMON_DOCUMENTS,
    ALL_VALID_DOCUMENT_TYPES,
    ALLOWED_MIME_TYPES,
    PROPRIETORSHIP_MANDATORY,
    PROPRIETORSHIP_BUSINESS_PROOFS,
    PROPRIETORSHIP_MIN_BUSINESS_PROOF
} from '../../../config/documentConfig.js';

/**
 * @desc    Get required documents list based on user's business_type
 * @route   GET /api/onboarding/user-documents/required
 * @access  Private (User)
 */
export const getRequiredDocuments = asyncHandler(async (req, res) => {
    const user = await getAuthenticatedUser(req, ['id', 'business_type']);
    const userId = user.id;

    if (!user.business_type) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Business type not set. Please set your business type first.');
    }

    // Commented out business type specific document list merge:
    // const specificDocs = BUSINESS_TYPE_DOCUMENTS[user.business_type] || [];
    // const allRequired = [...new Set([...COMMON_DOCUMENTS, ...specificDocs])];
    
    // Only return COMMON_DOCUMENTS for all business types right now:
    const allRequired = COMMON_DOCUMENTS;

    // Fetch already uploaded documents for this user
    const uploaded = await UserDocument.findAll({
        where: { userId },
        attributes: ['document_type', 'status', 'rejection_reason']
    });

    const uploadedMap = {};
    uploaded.forEach(doc => {
        uploadedMap[doc.document_type] = {
            status: doc.status,
            rejection_reason: doc.rejection_reason
        };
    });

    const documentList = allRequired.map(docType => ({
        document_type: docType,
        is_common: true, // COMMON_DOCUMENTS.includes(docType)
        uploaded: !!uploadedMap[docType],
        status: uploadedMap[docType]?.status || null,
        rejection_reason: uploadedMap[docType]?.rejection_reason || null,
    }));

    // Commented out proprietorship specific logic:
    // let proprietorshipInfo = null;
    // if (user.business_type === 'Proprietorship') {
    //     const uploadedProofs = uploaded.filter(d =>
    //         PROPRIETORSHIP_BUSINESS_PROOFS.includes(d.document_type)
    //     ).length;
    //     proprietorshipInfo = {
    //         mandatory_docs: PROPRIETORSHIP_MANDATORY,
    //         business_proof_uploaded: uploadedProofs,
    //         business_proof_required: PROPRIETORSHIP_MIN_BUSINESS_PROOF,
    //         business_proof_satisfied: uploadedProofs >= PROPRIETORSHIP_MIN_BUSINESS_PROOF
    //     };
    // }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            business_type: user.business_type,
            total_required: allRequired.length,
            total_uploaded: uploaded.length,
            documents: documentList
            // , ...(proprietorshipInfo && { proprietorship_info: proprietorshipInfo })
        }, 'Required documents fetched successfully.')
    );
});

/**
 * @desc    Upload a document (re-upload replaces existing)
 * @route   POST /api/onboarding/user-documents/upload
 * @access  Private (User)
 */
export const uploadUserDocument = asyncHandler(async (req, res) => {
    const user = await getAuthenticatedUser(req, ['id', 'business_type']);
    const userId = user.id;
 
    const { document_type } = req.body;
    if (!document_type) throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'document_type is required.');
 
    // Validate document_type
    if (!ALL_VALID_DOCUMENT_TYPES.includes(document_type)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid document_type: "${document_type}".`);
    }
 
    // Validate file
    if (!req.file) throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Please upload a file.');
 
    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid file type. Only PDF, JPG, and PNG are allowed.');
    }

    if (!user.business_type) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Business type not set. Please set your business type first.');
    }

    // Upload to Cloudflare R2
    const safeDocType = document_type.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const uploadResult = await uploadToR2(req.file.buffer, {
        folder: 'user_documents',
        publicId: `user_${userId}_${safeDocType}_${Date.now()}`
    });

    // Upsert: create or replace existing document
    const [docRecord, created] = await UserDocument.findOrCreate({
        where: { userId, document_type },
        defaults: {
            userId,
            business_type: user.business_type,
            document_type,
            document_url: uploadResult.secure_url,
            status: 'pending',
            rejection_reason: null
        }
    });

    if (!created) {
        // Replace existing document (re-upload)
        docRecord.document_url = uploadResult.secure_url;
        docRecord.status = 'pending';
        docRecord.rejection_reason = null;
        docRecord.business_type = user.business_type;
        await docRecord.save();
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            id: docRecord.id,
            document_type: docRecord.document_type,
            business_type: docRecord.business_type,
            document_url: docRecord.document_url,
            status: docRecord.status,
            is_replace: !created
        }, `${document_type} ${created ? 'uploaded' : 'replaced'} successfully!`)
    );
});

/**
 * @desc    Get all uploaded documents of the logged-in user
 * @route   GET /api/onboarding/user-documents/my
 * @access  Private (User)
 */
export const getMyDocuments = asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Access Denied. Authentication required.');

    const documents = await UserDocument.findAll({
        where: { userId },
        attributes: ['id', 'business_type', 'document_type', 'document_url', 'status', 'rejection_reason', 'createdAt', 'updatedAt'],
        order: [['createdAt', 'DESC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            total: documents.length,
            documents
        }, 'Documents fetched successfully.')
    );
});
