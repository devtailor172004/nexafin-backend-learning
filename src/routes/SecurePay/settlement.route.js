import express from 'express';
import { verifyAdmin } from '../../middlewares/authMiddleware.js';
import {
    getSettlementOverview,
    triggerSettlement
} from '../../controllers/SecurePay/settlement.controller.js';

const router = express.Router();

/**
 * Settlement Center (Admin only).
 * Settlement is tracked separately from payment status — see
 * src/securepay/settlement.js for the rationale.
 */
router.get('/summary', verifyAdmin, getSettlementOverview);
router.post('/run', verifyAdmin, triggerSettlement);

export default router;
