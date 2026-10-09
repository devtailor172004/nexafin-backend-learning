import pkg from 'sequelize';
const { Op } = pkg;

import RiskEvent from '../../models/RiskEvent.js';
import AccountFreeze from '../../models/AccountFreeze.js';
import SecurityIncident from '../../models/SecurityIncident.js';
import User from '../../models/User.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../utils/httpStatus.js';
import { getPaginationParams } from '../../utils/paginationHelper.js';
import {
    buildSecurityOverview,
    listRiskEvents,
    getIncidentTimeline,
    reviewRiskEvent,
    freezeAccount,
    unfreezeAccount
} from '../../securepay/fraudService.js';
import { verifyAuditChainFromDb, getAuditChainTip } from '../../securepay/auditLog.js';
import { runInvariantChecks } from '../../securepay/ledger.js';
import { runFraudLabScenario, FRAUD_LAB_SCENARIOS } from '../../securepay/fraudLab.js';

const ok = (res, data, message = 'Success', statusCode = 200) =>
    res.status(statusCode).json(new ApiResponse(statusCode, data, message));

/**
 * @desc   Security Center overview metrics
 * @route  GET /api/securepay/security/overview
 * @access Private (Admin)
 */
export const getSecurityOverview = asyncHandler(async (req, res) => {
    const includeIntegrity = req.query.integrity !== 'false';
    const overview = await buildSecurityOverview({ integrityChecks: includeIntegrity });
    return ok(res, overview);
});

/**
 * @desc   List / filter security (risk) events
 * @route  GET /api/securepay/security/events
 * @access Private (Admin)
 */
export const listSecurityEvents = asyncHandler(async (req, res) => {
    const { pageNum, limitNum, offset } = getPaginationParams(req.query.page, req.query.limit, 25, 200);
    const result = await listRiskEvents({
        limit,
        offset,
        decision: req.query.decision,
        riskLevel: req.query.riskLevel,
        status: req.query.status,
        userId: req.query.userId ? Number(req.query.userId) : null,
        from: req.query.from,
        to: req.query.to,
        search: req.query.search
    });
    return ok(res, { ...result, page: pageNum, limit: limitNum });
});

/**
 * @desc   Single security event with the ordered audit/decision context
 * @route  GET /api/securepay/security/events/:uuid
 * @access Private (Admin)
 */
export const getSecurityEvent = asyncHandler(async (req, res) => {
    const event = await RiskEvent.findOne({ where: { uuid: req.params.uuid } });
    if (!event) throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, 'Security event not found.');

    const related = event.correlationId
        ? await RiskEvent.findAll({ where: { correlationId: event.correlationId }, order: [['id', 'ASC']] })
        : [event];

    const freezes = event.userId
        ? await AccountFreeze.findAll({ where: { userId: event.userId }, order: [['id', 'DESC']] })
        : [];

    return ok(res, {
        event: {
            id: event.uuid,
            userId: event.userId,
            transactionId: event.transactionId,
            operation: event.operation,
            amountMinor: Number(event.amountMinor),
            currency: event.currency,
            riskScore: event.riskScore,
            riskLevel: event.riskLevel,
            decision: event.decision,
            status: event.status,
            rulesTriggered: event.rulesTriggered || [],
            explanations: event.explanations || [],
            correlationId: event.correlationId,
            reviewDecision: event.reviewDecision,
            reviewReason: event.reviewReason,
            reviewedAt: event.reviewedAt,
            createdAt: event.createdAt
        },
        relatedEvents: related.map((r) => ({
            id: r.uuid,
            decision: r.decision,
            riskLevel: r.riskLevel,
            riskScore: r.riskScore,
            createdAt: r.createdAt
        })),
        freezes: freezes.map((f) => ({
            id: f.uuid,
            scope: f.scope,
            status: f.status,
            reason: f.reason,
            frozenAt: f.frozenAt,
            releasedAt: f.releasedAt,
            releaseReason: f.releaseReason
        }))
    });
});

/**
 * @desc   Administrator review of a hold/block (RELEASE | CONFIRM | ESCALATE)
 * @route  POST /api/securepay/security/events/:uuid/review
 * @access Private (Admin)
 */
export const reviewSecurityEvent = asyncHandler(async (req, res) => {
    const { action, reason } = req.body || {};
    const result = await reviewRiskEvent({
        riskEventId: req.params.uuid,
        action,
        reason,
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null
    });
    return ok(res, result, 'Review recorded');
});

/**
 * @desc   List active/historical freezes
 * @route  GET /api/securepay/security/freezes
 * @access Private (Admin)
 */
export const listFreezes = asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const where = status ? { status } : {};
    const freezes = await AccountFreeze.findAll({
        where,
        order: [['id', 'DESC']],
        limit: 100,
        include: [{ model: User, as: 'User', attributes: ['id', 'fullName', 'email'], required: false }]
    });

    return ok(res, {
        items: freezes.map((f) => ({
            id: f.uuid,
            userId: f.userId,
            retailer: f.User ? { id: f.User.id, fullName: f.User.fullName, email: f.User.email } : null,
            scope: f.scope,
            status: f.status,
            reason: f.reason,
            frozenAt: f.frozenAt,
            releasedAt: f.releasedAt,
            releaseReason: f.releaseReason
        }))
    });
});

/**
 * @desc   Freeze a synthetic account (admin, reason required)
 * @route  POST /api/securepay/security/freezes
 * @access Private (Admin)
 */
export const createFreeze = asyncHandler(async (req, res) => {
    const { userId, reason, scope } = req.body || {};
    if (!userId) throw new ApiError(HTTP_STATUS.BAD_REQUEST || 400, 'userId is required.');

    const freeze = await freezeAccount({
        userId: Number(userId),
        reason,
        scope: scope || 'ACCOUNT',
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null
    });

    return ok(res, {
        id: freeze.uuid,
        userId: freeze.userId,
        scope: freeze.scope,
        status: freeze.status,
        reason: freeze.reason,
        frozenAt: freeze.frozenAt
    }, 'Account frozen', 201);
});

/**
 * @desc   Release an account freeze (admin, reason required)
 * @route  POST /api/securepay/security/freezes/:userId/release
 * @access Private (Admin)
 */
export const releaseFreeze = asyncHandler(async (req, res) => {
    const { reason, scope } = req.body || {};
    const released = await unfreezeAccount({
        userId: Number(req.params.userId),
        reason,
        scope: scope || null,
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null
    });
    return ok(res, { released }, 'Freeze released');
});

/**
 * @desc   Incident timeline (risk evaluations, decisions, freezes, audit)
 * @route  GET /api/securepay/security/incidents/:uuid
 * @access Private (Admin)
 */
export const getIncident = asyncHandler(async (req, res) => {
    const timeline = await getIncidentTimeline(req.params.uuid);
    return ok(res, timeline);
});

/**
 * @desc   List incidents
 * @route  GET /api/securepay/security/incidents
 * @access Private (Admin)
 */
export const listIncidents = asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).split(',').map((s) => s.trim().toUpperCase()) : null;
    const where = status ? { status: { [Op.in]: status } } : {};
    const incidents = await SecurityIncident.findAll({ where, order: [['id', 'DESC']], limit: 100 });

    return ok(res, {
        items: incidents.map((i) => ({
            id: i.uuid,
            title: i.title,
            description: i.description,
            severity: i.severity,
            status: i.status,
            primaryUserId: i.primaryUserId,
            riskEventCount: (i.riskEventIds || []).length,
            correlationId: i.correlationId,
            createdAt: i.createdAt,
            closedAt: i.closedAt
        }))
    });
});

/**
 * @desc   Verify the audit hash chain
 * @route  GET /api/securepay/security/audit/integrity
 * @access Private (Admin)
 */
export const getAuditIntegrity = asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : null;
    const [result, tip] = await Promise.all([
        verifyAuditChainFromDb({ limit }),
        getAuditChainTip()
    ]);
    return ok(res, { ...result, tip });
});

/**
 * @desc   Run ledger invariant checks
 * @route  GET /api/securepay/security/ledger/integrity
 * @access Private (Admin)
 */
export const getLedgerIntegrity = asyncHandler(async (req, res) => {
    const result = await runInvariantChecks({
        transactionRef: req.query.transactionRef || null
    });
    return ok(res, result);
});

/**
 * @desc   List the Fraud Lab scenarios (safe metadata only)
 * @route  GET /api/securepay/security/scenarios
 * @access Private (Admin)
 */
export const listScenarios = asyncHandler(async (req, res) => {
    return ok(res, {
        scenarios: FRAUD_LAB_SCENARIOS.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            whatItTests: s.whatItTests,
            expected: s.expected,
            requires: s.requires || []
        })),
        sandbox: true,
        warning: 'All financial operations in the Fraud Lab are simulated against synthetic sandbox data.'
    });
});

/**
 * @desc   Run a Fraud Lab scenario (sandbox only)
 * @route  POST /api/securepay/security/scenarios/:id/run
 * @access Private (Admin)
 */
export const runScenario = asyncHandler(async (req, res) => {
    const scenarioId = String(req.params.id || '').toUpperCase();
    const params = req.body || {};

    const result = await runFraudLabScenario({
        scenarioId,
        params,
        actor: { id: req.user?.id || null, role: req.user?.role || null },
        ipAddress: req.ip,
        requestId: req.id
    });

    return ok(res, result, result.passed ? 'Scenario passed' : 'Scenario completed with findings');
});
