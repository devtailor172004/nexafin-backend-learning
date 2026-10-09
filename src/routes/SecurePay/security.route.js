import express from 'express';
import { verifyAdmin } from '../../middlewares/authMiddleware.js';
import {
    getSecurityOverview,
    listSecurityEvents,
    getSecurityEvent,
    reviewSecurityEvent,
    listFreezes,
    createFreeze,
    releaseFreeze,
    getIncident,
    listIncidents,
    getAuditIntegrity,
    getLedgerIntegrity,
    listScenarios,
    runScenario
} from '../../controllers/SecurePay/security.controller.js';

const router = express.Router();

/**
 * Security Center.
 *
 * Every endpoint is Admin-scoped and enforced server-side — hiding a control in
 * the React app is never treated as authorization. Scenario execution and any
 * endpoint that can change account security state also require a documented
 * reason in the request body, which is written to the audit trail.
 */
router.get('/overview', verifyAdmin, getSecurityOverview);

router.get('/events', verifyAdmin, listSecurityEvents);
router.get('/events/:uuid', verifyAdmin, getSecurityEvent);
router.post('/events/:uuid/review', verifyAdmin, reviewSecurityEvent);

router.get('/freezes', verifyAdmin, listFreezes);
router.post('/freezes', verifyAdmin, createFreeze);
router.post('/freezes/:userId/release', verifyAdmin, releaseFreeze);

router.get('/incidents', verifyAdmin, listIncidents);
router.get('/incidents/:uuid', verifyAdmin, getIncident);

router.get('/audit/integrity', verifyAdmin, getAuditIntegrity);
router.get('/ledger/integrity', verifyAdmin, getLedgerIntegrity);

router.get('/scenarios', verifyAdmin, listScenarios);
router.post('/scenarios/:id/run', verifyAdmin, runScenario);

export default router;
