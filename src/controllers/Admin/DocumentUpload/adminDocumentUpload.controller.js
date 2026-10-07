import sequelize from '../../../config/db.js';
import User from '../../../models/User.js';
import UserDocument from '../../../models/UserDocument.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';

/**
 * @desc    View all uploaded documents of a specific user strictly by UUID (Admin)
 * @route   GET /api/admin/document-upload/:uuid/documents
 * @access  Private (Admin)
 */
export const getUserDocuments = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const user = await User.findOne({
        where: { uuid },
        attributes: ['id', 'uuid', 'fullName', 'business_type']
    });
    if (!user) throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found!');

    const documents = await UserDocument.findAll({
        where: { userId: user.id },
        attributes: ['id', 'uuid', 'business_type', 'document_type', 'document_url', 'status', 'rejection_reason', 'createdAt', 'updatedAt'],
        order: [['createdAt', 'DESC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            user: { id: user.id, uuid: user.uuid, fullName: user.fullName, business_type: user.business_type },
            total: documents.length,
            documents
        }, 'User documents fetched successfully.')
    );
});

/**
 * @desc    Verify or Reject a specific document strictly by UUID (Admin)
 * @route   PUT /api/admin/document-upload/documents/:uuid/status
 * @access  Private (Admin)
 */
export const updateDocumentStatus = asyncHandler(async (req, res) => {
    const {uuid} = req.params;
    const { status, rejection_reason } = req.body;

    if (!status) throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'status is required.');

    const validStatuses = ['pending', 'verified', 'rejected'];
    if (!validStatuses.includes(status)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    if (status === 'rejected' && !rejection_reason) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'rejection_reason is required when rejecting a document.');
    }

    const doc = await UserDocument.findOne({ where: { uuid } });
    if (!doc) throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Document not found!');

    await sequelize.transaction(async (t) => {
        doc.status = status;
        doc.rejection_reason = status === 'rejected' ? rejection_reason : null;
        await doc.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            id: doc.id,
            uuid: doc.uuid,
            document_type: doc.document_type,
            status: doc.status,
            rejection_reason: doc.rejection_reason
        }, `Document status updated to '${status}' successfully!`)
    );
});

/**
 * @desc    Delete a specific document strictly by UUID (Admin)
 * @route   DELETE /api/admin/document-upload/documents/:uuid
 * @access  Private (Admin)
 */
export const deleteDocument = asyncHandler(async (req, res) => {
    const {uuid} = req.params;

    const doc = await UserDocument.findOne({ where: { uuid } });
    if (!doc) throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Document not found!');

    await sequelize.transaction(async (t) => {
        await doc.destroy({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, null, 'Document deleted successfully.')
    );
});
