import express from 'express';
import { signInAuth, verifyBusinessAddress, uploadVideoKYC } from '../../../controllers/Onboarding/DocKYC/docKYC.controller.js';
import { verifyToken } from '../../../middlewares/authMiddleware.js';
import upload from '../../../middlewares/upload.js';
import documentUpload from '../../../middlewares/documentUpload.js';

const router = express.Router();

router.post('/signin-auth', verifyToken, signInAuth);
router.post('/verify-business-address', verifyToken, documentUpload.single('business_proof'), verifyBusinessAddress);
router.post('/video-kyc', verifyToken, upload.single('video'), uploadVideoKYC);

export default router;
