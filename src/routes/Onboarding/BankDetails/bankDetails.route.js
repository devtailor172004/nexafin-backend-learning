import express from 'express';
import { saveBankDetails } from '../../../controllers/Onboarding/BankDetails/bankDetails.controller.js';
import { verifyToken } from '../../../middlewares/authMiddleware.js';
import documentUpload from '../../../middlewares/documentUpload.js';

const router = express.Router();

router.patch('/update', verifyToken, documentUpload.single('bank_proof'), saveBankDetails);

export default router;
