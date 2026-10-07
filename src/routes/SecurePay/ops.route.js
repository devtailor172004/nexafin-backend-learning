import express from 'express';
import { verifyAdmin } from '../../middlewares/authMiddleware.js';
import {
    getOperationsDashboard,
    getLiveTransactions,
    getProviderHealth,
    getPaymentTimeline,
    explainPayment,
    getCustomerOverview,
    streamLiveEvents
} from '../../controllers/SecurePay/ops.controller.js';

const router = express.Router();

/**
 * Real-time operations layer.
 *
 * All read endpoints are admin-scoped. The SSE stream authenticates itself
 * from `?token=` (EventSource cannot send an Authorization header) and
 * enforces the Admin role inside the controller.
 */
router.get('/dashboard', verifyAdmin, getOperationsDashboard);
router.get('/transactions/live', verifyAdmin, getLiveTransactions);
router.get('/providers/health', verifyAdmin, getProviderHealth);
router.get('/payments/:uuid/timeline', verifyAdmin, getPaymentTimeline);
router.get('/payments/:uuid/explain', verifyAdmin, explainPayment);
router.get('/customers/:uuid/overview', verifyAdmin, getCustomerOverview);

// SSE: authenticates via ?token=<JWT>
router.get('/stream', streamLiveEvents);

export default router;
