
import express from 'express';
import { getKycProfiles, getKycProfileById, updateKycStatus, getKycJourney, reviewUserDocument, recordLivenessCheck } from '../../../controllers/Admin/KYC/adminKYC.controller.js';
import { verifyAdmin } from '../../../middlewares/authMiddleware.js';

const router = express.Router();
// Route to get all KYC profiles (defaults to pending, can filter by ?status=)
router.get('/', verifyAdmin, getKycProfiles);

// Route to get a specific user's complete KYC profile & directors by UUID
router.get('/:uuid', verifyAdmin, getKycProfileById);

// Route to approve or reject a user's KYC status by UUID
router.put('/:uuid/status', verifyAdmin, updateKycStatus);

// Full KYC journey: steps, blockers, completion percentage
router.get('/:uuid/journey', verifyAdmin, getKycJourney);

// Approve / reject a single uploaded document    router.patch('/:uuid/documents/:documentUuid/status', verifyAdmin, reviewUserDocument);

    // Camera liveness test (admin, demo/testing)
    router.post('/:uuid/liveness', verifyAdmin, recordLivenessCheck);

export default router;