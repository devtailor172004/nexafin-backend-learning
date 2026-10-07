import express from 'express';
import {
    getUserDocuments,
    updateDocumentStatus,
    deleteDocument
} from '../../../controllers/Admin/DocumentUpload/adminDocumentUpload.controller.js';
import { verifyAdmin } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

// GET  /api/admin/document-upload/:uuid/documents       → View all documents of a user by UUID
router.get('/:uuid/documents', verifyAdmin, getUserDocuments);

// PUT  /api/admin/document-upload/documents/:uuid/status → Verify or Reject a document by UUID
router.put('/documents/:uuid/status', verifyAdmin, updateDocumentStatus);

// DELETE /api/admin/document-upload/documents/:uuid  → Delete a document by UUID (Admin only)
router.delete('/documents/:uuid', verifyAdmin, deleteDocument);

export default router;
