
import express from 'express';
import { getKycProfiles, getKycProfileById, updateKycStatus } from '../../../controllers/Admin/KYC/adminKYC.controller.js';
import { verifyAdmin } from '../../../middlewares/authMiddleware.js';

const router = express.Router();
// Route to get all KYC profiles (defaults to pending, can filter by ?status=)
router.get('/', verifyAdmin, getKycProfiles);

// Route to get a specific user's complete KYC profile & directors by UUID
router.get('/:uuid', verifyAdmin, getKycProfileById);

// Route to approve or reject a user's KYC status by UUID
router.put('/:uuid/status', verifyAdmin, updateKycStatus);

export default router;