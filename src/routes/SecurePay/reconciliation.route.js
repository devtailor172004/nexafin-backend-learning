import express from 'express';
import { verifyAdmin } from '../../middlewares/authMiddleware.js';
import {
    createReconciliationRun,
    listReconciliationRuns,
    getReconciliationRun,
    listReconciliationExceptions,
    getReconciliationSummary,
    updateReconciliationException
} from '../../controllers/SecurePay/reconciliation.controller.js';

const router = express.Router();

/**
 * Reconciliation Center (Admin only).
 *
 * Declared before the parameterized run route so "summary" is never treated as
 * a run UUID.
 */
router.get('/summary', verifyAdmin, getReconciliationSummary);
router.get('/runs', verifyAdmin, listReconciliationRuns);
router.post('/runs', verifyAdmin, createReconciliationRun);
router.get('/runs/:uuid', verifyAdmin, getReconciliationRun);

router.get('/exceptions', verifyAdmin, listReconciliationExceptions);
router.patch('/exceptions/:uuid', verifyAdmin, updateReconciliationException);

export default router;
