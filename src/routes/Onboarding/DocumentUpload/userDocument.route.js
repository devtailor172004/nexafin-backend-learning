import express from 'express';
import {
    getRequiredDocuments,
    uploadUserDocument,
    getMyDocuments
} from '../../../controllers/Onboarding/DocumentUpload/userDocument.controller.js';
import { verifyToken } from '../../../middlewares/authMiddleware.js';
import documentUpload from '../../../middlewares/documentUpload.js';

const router = express.Router();

// GET  /api/onboarding/user-documents/required  → Required docs list per business type
router.get('/required', verifyToken, getRequiredDocuments);

// POST /api/onboarding/user-documents/upload    → Upload / Re-upload a document
router.post('/upload', verifyToken, documentUpload.single('file'), uploadUserDocument);

// GET  /api/onboarding/user-documents/my        → My uploaded documents
router.get('/my', verifyToken, getMyDocuments);

export default router;
