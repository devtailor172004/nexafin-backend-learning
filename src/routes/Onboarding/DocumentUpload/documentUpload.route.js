import express from 'express';
import { panUpload, aadharcardUpload, businessProofUpload } from '../../../controllers/Onboarding/DocumentUpload/documentUpload.controller.js';
import { verifyToken } from '../../../middlewares/authMiddleware.js';
import documentUpload from '../../../middlewares/documentUpload.js';

const router = express.Router();

router.post('/pan', verifyToken, documentUpload.single('pan_file'), panUpload);
router.post('/aadhar', verifyToken, documentUpload.single('aadharcard_file'), aadharcardUpload);
router.post('/business-proof', verifyToken, documentUpload.single('business_proof_file'), businessProofUpload);

export default router;
