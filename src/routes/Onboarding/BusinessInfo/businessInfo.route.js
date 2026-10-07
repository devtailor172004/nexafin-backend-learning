import express from 'express';
import { verifyPan, verifyCin, verifyGst, updateBusinessType, updateBusinessCategory, updateBusinessUrls, updateKycStep } from '../../../controllers/Onboarding/BusinessInfo/businessInfo.controller.js';
import { verifyToken } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/verify-pan', verifyToken, verifyPan);
router.post('/verfiy-cin', verifyToken, verifyCin);
router.post('/verify-gst', verifyToken, verifyGst);
router.patch('/update-business-type', verifyToken, updateBusinessType);
router.patch('/update-business-category', verifyToken, updateBusinessCategory);
router.patch('/update-business-urls', verifyToken, updateBusinessUrls);

//update kyc_step and category
router.patch('/update-kyc-step', verifyToken, updateKycStep);


export default router;
