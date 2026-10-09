import pkg from 'sequelize';
const { Op, fn, col } = pkg;

import RiskEvent from '../models/RiskEvent.js';
import AccountFreeze from '../models/AccountFreeze.js';
import SecurityIncident from '../models/SecurityIncident.js';
import ProviderWebhookEvent from '../models/ProviderWebhookEvent.js';
import AuditLog from '../models/AuditLog.js';
import { writeAuditLog, verifyAuditChainFromDb } from './auditLog.js';
import { runInvariantChecks } from './ledger.js';
import { evaluateRisk, isBlockingDecision } from './fraudEngine.js';
import { loadFraudConfig, RISK_DECISION, RISK_LEVEL } from '../config/fraudConfig.js';
import { publishSecurityEvent, SECURITY_EVENT } from './securityEvents.js';
import { ApiError } from '../utils/ApiError.js';
import { HTTP_STATUS } from '../utils/httpStatus.js';
import logger from '../utils/logger.js';

/**
 * Fraud orchestration.
 *
 * The pure engine decides *what* the risk is; this service decides *what
 * happens*: persisting the risk event, freezing the account where policy
 * requires it, opening an incident, writing the audit trail and publishing a
 * real-time security event.
 *
 * Freeze policy is configurable. By default a HOLD or BLOCK puts the account's
 * money-moving capability on ice until an administrator reviews the case and
 * gives a reason.
 */

export const FRAUD_FREEZE_ON = (process.env.FRAUD_FREEZE_ON || 'HOLD,BLOCK')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

const config = () => loadFraudConfig();

const freezeDecisions = new Set(FRAUD_FREEZE_ON);

/**
 * Builds the aggregate context the engine scores against.
 *
 * Velocity, baseline and repeat-after-block are derived from persisted risk
 * events. Beneficiary/device signals have no dedicated module in this codebase
 * yet, so they are supplied by the caller (the Fraud Lab scenarios pass them
 * explicitly) and are clearly marked here rather than being invented.
 */
export const buildRiskContext = async ({ userId, amountMinor = 0, signals = {}, nowMs = Date.now(), transaction = null }) => {
    const cfg = config();
    const velocitySince = new Date(nowMs - cfg.windows.velocityMinutes * 60_000);
    const baselineSince = new Date(nowMs - cfg.windows.baselineDays * 86_400_000);

    const [recentTransactionCount, baselineRow, blockedAttemptsRecently] = await Promise.all([
        RiskEvent.count({
            where: { userId, createdAt: { [Op.gte]: velocitySince } },
            transaction
        }),
        RiskEvent.findAll({
            attributes: [[fn('AVG', col('amountMinor')), 'avgAmount']],
            where: { userId, createdAt: { [Op.gte]: baselineSince }, amountMinor: { [Op.gt]: 0 } },
            raw: true,
            transaction
        }),
        RiskEvent.count({
            where: {
                userId,
                createdAt: { [Op.gte]: velocitySince },
                decision: { [Op.in]: [RISK_DECISION.BLOCK, RISK_DECISION.HOLD] }
            },
            transaction
        })
    ]);

    const baselineAvgAmountMinor = Math.round(Number(baselineRow?.[0]?.avgAmount) || 0);
    const baselineDeviationPercent = baselineAvgAmountMinor > 0
        ? ((amountMinor - baselineAvgAmountMinor) / baselineAvgAmountMinor) * 100
        : undefined;

    return {
        recentTransactionCount,
        baselineAvgAmountMinor,
        blockedAttemptsRecently,
        baselineDeviationPercent,
        // Caller-supplied until dedicated beneficiary/device modules exist.
        beneficiariesAddedRecently: signals.beneficiariesAddedRecently ?? 0,
        beneficiaryVerified: signals.beneficiaryVerified,
        beneficiaryAgeMinutes: signals.beneficiaryAgeMinutes,
        failedAuthAttempts: signals.failedAuthAttempts ?? 0,
        newDevice: signals.newDevice ?? false,
        distinctBeneficiariesRecently: signals.distinctBeneficiariesRecently ?? 0,
        nowMs
    };
};

/** Active freeze for a user, if any. */
export const findActiveFreeze = async ({ userId, scope = null, transaction = null }) => {
    const where = { userId, status: 'ACTIVE' };
    if (scope) where.scope = { [Op.in]: [scope, 'ACCOUNT'] };
    return AccountFreeze.findOne({ where, order: [['id', 'DESC']], transaction });
};

/**
 * The authorization-style guard every money-moving endpoint must call.
 * Throws rather than returning a flag so a caller cannot forget to check it.
 */
export const assertMayMoveMoney = async ({ userId, scope = 'PAYOUT', transaction = null }) => {
    const freeze = await findActiveFreeze({ userId, scope, transaction });
    if (!freeze) return true;

    throw new ApiError(
        HTTP_STATUS.FORBIDDEN || 403,
        `This account is frozen (${freeze.scope}). An administrator must review and release the freeze before further payouts.`,
        [{ reason: freeze.reason, freezeId: freeze.uuid }]
    );
};

/**
 * Opens (or reuses) an incident for a user, linking the triggering risk event.
 */
export const openIncidentIfNeeded = async ({
    userId,
    title,
    description,
    severity = 'HIGH',
    correlationId = null,
    riskEventId = null,
    actorId = null,
    transaction = null
}) => {
    const existing = await SecurityIncident.findOne({
        where: { primaryUserId: userId, status: { [Op.in]: ['OPEN', 'INVESTIGATING'] } },
        order: [['id', 'DESC']],
        transaction
    });

    if (existing) {
        if (riskEventId) {
            const ids = new Set([...(existing.riskEventIds || []), Number(riskEventId)]);
            existing.riskEventIds = [...ids];
            await existing.save({ transaction });
        }
        return existing;
    }

    const incident = await SecurityIncident.create({
        title,
        description,
        severity,
        primaryUserId: userId,
        correlationId,
        openedById: actorId,
        riskEventIds: riskEventId ? [Number(riskEventId)] : []
    }, { transaction });

    publishSecurityEvent(SECURITY_EVENT.INCIDENT_OPENED, {
        incidentId: incident.uuid,
        userId,
        severity,
        title,
        correlationId
    });

    return incident;
};

/**
 * Records a security decision into the hash-chained audit trail.
 * Blocking decisions are written as critical, so a financial action cannot
 * silently succeed without its trail.
 */
const auditSecurity = (payload) => writeAuditLog({
    source: 'SECURITY',
    ...payload,
    critical: payload.critical ?? false
});

/**
 * Evaluates one money-moving attempt and applies the configured protection.
 *
 * @returns {Promise<object>} the engine result plus the persisted risk event id,
 *          whether an account freeze was applied and any incident opened.
 */
export const evaluateAttempt = async ({
    userId,
    transactionId = null,
    amountMinor = 0,
    currency = 'INR',
    operation = 'PAYOUT',
    signals = {},
    actorId = null,
    actorRole = null,
    ipAddress = null,
    requestId = null,
    correlationId = null
}) => {
    const cfg = config();

    // 1. An active freeze short-circuits: no scoring, but the attempt is still
    //    recorded and surfaced so the dashboard shows continued abuse.
    const activeFreeze = await findActiveFreeze({ userId });
    if (activeFreeze) {
        const blocked = {
            transactionId,
            retailerId: userId,
            operation,
            amountMinor,
            currency,
            riskScore: 100,
            riskLevel: RISK_LEVEL.CRITICAL,
            decision: RISK_DECISION.BLOCK,
            rulesTriggered: [{
                rule: 'ACCOUNT_FROZEN',
                weight: 0,
                explanation: `Account is frozen (${activeFreeze.scope}): ${activeFreeze.reason}`,
                evidence: { freezeId: activeFreeze.uuid, scope: activeFreeze.scope }
            }],
            explanations: [`ACCOUNT_FROZEN: account is frozen (${activeFreeze.scope}).`],
            configVersion: cfg.version,
            evaluatedAt: new Date().toISOString(),
            correlationId: correlationId || undefined
        };

        const riskEvent = await RiskEvent.create({
            userId,
            transactionId,
            operation,
            amountMinor,
            currency,
            riskScore: blocked.riskScore,
            riskLevel: blocked.riskLevel,
            decision: blocked.decision,
            rulesTriggered: blocked.rulesTriggered,
            explanations: blocked.explanations,
            configVersion: cfg.version,
            status: 'OPEN',
            correlationId: blocked.correlationId,
            requestId,
            ipAddress
        });

        await auditSecurity({
            actorId,
            actorRole,
            action: 'RISK_BLOCKED_FROZEN_ACCOUNT',
            entityType: 'risk_event',
            entityId: riskEvent.uuid,
            description: `Money-moving attempt blocked: account frozen (${activeFreeze.scope}).`,
            outcome: 'DENIED',
            reason: activeFreeze.reason,
            correlationId: blocked.correlationId,
            requestId,
            ipAddress,
            critical: true
        });

        publishSecurityEvent(SECURITY_EVENT.RISK_BLOCKED, {
            riskEventId: riskEvent.uuid,
            userId,
            amountMinor,
            currency,
            reason: 'ACCOUNT_FROZEN',
            correlationId: blocked.correlationId
        });

        return { ...blocked, riskEventId: riskEvent.uuid, frozen: true, incidentId: null };
    }

    // 2. Score.
    const context = await buildRiskContext({ userId, amountMinor, signals });
    const evaluation = evaluateRisk({
        attempt: { retailerId: userId, transactionId, amountMinor, currency, operation },
        context,
        config: cfg,
        correlationId
    });

    // 3. Persist the evaluation (including ALLOW, so counts are genuine).
    const riskEvent = await RiskEvent.create({
        userId,
        transactionId,
        operation,
        amountMinor,
        currency,
        riskScore: evaluation.riskScore,
        riskLevel: evaluation.riskLevel,
        decision: evaluation.decision,
        rulesTriggered: evaluation.rulesTriggered,
        explanations: evaluation.explanations,
        configVersion: evaluation.configVersion,
        status: isBlockingDecision(evaluation.decision) ? 'OPEN' : 'RESOLVED',
        correlationId: evaluation.correlationId,
        requestId,
        ipAddress,
        metadata: { context: { ...context, nowMs: undefined } }
    });

    const blocking = isBlockingDecision(evaluation.decision);

    await auditSecurity({
        actorId,
        actorRole,
        action: blocking ? 'RISK_TRANSACTION_HELD' : 'RISK_EVALUATED',
        entityType: 'risk_event',
        entityId: riskEvent.uuid,
        description: `Risk ${evaluation.riskScore}/${evaluation.riskLevel} -> ${evaluation.decision}`,
        outcome: blocking ? 'BLOCKED' : 'ALLOWED',
        reason: evaluation.explanations.join(' | ') || null,
        correlationId: evaluation.correlationId,
        requestId,
        ipAddress,
        before: null,
        after: { decision: evaluation.decision, riskScore: evaluation.riskScore },
        critical: blocking
    });

    publishSecurityEvent(blocking ? SECURITY_EVENT.RISK_HOLD : SECURITY_EVENT.RISK_EVALUATED, {
        riskEventId: riskEvent.uuid,
        userId,
        decision: evaluation.decision,
        riskScore: evaluation.riskScore,
        riskLevel: evaluation.riskLevel,
        rules: evaluation.rulesTriggered.map((r) => r.rule),
        amountMinor,
        currency,
        correlationId: evaluation.correlationId
    });

    let freeze = null;
    let incident = null;

    // 4. Apply protection.
    if (blocking && freezeDecisions.has(evaluation.decision)) {
        freeze = await freezeAccount({
            userId,
            reason: `Automatic hold: ${evaluation.rulesTriggered.map((r) => r.rule).join(', ') || evaluation.decision}`,
            actorId,
            actorRole,
            sourceRiskEventId: riskEvent.id,
            correlationId: evaluation.correlationId,
            automatic: true
        });

        incident = await openIncidentIfNeeded({
            userId,
            title: `High-risk payout activity (${evaluation.riskLevel})`,
            description: evaluation.explanations.join('\n'),
            severity: evaluation.riskLevel,
            correlationId: evaluation.correlationId,
            riskEventId: riskEvent.id
        });

        riskEvent.incidentId = incident.id;
        await riskEvent.save();
    }

    return {
        ...evaluation,
        riskEventId: riskEvent.uuid,
        frozen: Boolean(freeze),
        freezeId: freeze?.uuid || null,
        incidentId: incident?.uuid || null,
        incidentUuid: incident?.uuid || null,
        blocked: blocking
    };
};

/**
 * Freezes a synthetic account. Idempotent: an existing ACTIVE freeze of the same
 * scope is reused rather than stacked.
 */
export const freezeAccount = async ({
    userId,
    reason,
    actorId = null,
    actorRole = null,
    scope = 'ACCOUNT',
    sourceRiskEventId = null,
    correlationId = null,
    automatic = false
}) => {
    if (!reason || String(reason).trim().length < 3) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST || 400, 'A freeze reason is required.');
    }

    const existing = await findActiveFreeze({ userId, scope });
    if (existing) return existing;

    const freeze = await AccountFreeze.create({
        userId,
        scope,
        status: 'ACTIVE',
        reason: String(reason).trim(),
        sourceRiskEventId,
        frozenById: actorId,
        frozenAt: new Date(),
        correlationId
    });

    await auditSecurity({
        actorId,
        actorRole,
        action: automatic ? 'ACCOUNT_AUTO_FROZEN' : 'ACCOUNT_FROZEN',
        entityType: 'account_freeze',
        entityId: freeze.uuid,
        description: `Account frozen (${scope}).`,
        outcome: 'SUCCESS',
        reason,
        correlationId,
        after: { userId, scope, status: 'ACTIVE' },
        critical: true
    });

    publishSecurityEvent(SECURITY_EVENT.ACCOUNT_FROZEN, {
        freezeId: freeze.uuid,
        userId,
        scope,
        reason,
        automatic,
        correlationId
    });

    return freeze;
};

/** Releases the active freeze(s) for a user. Requires an administrator reason. */
export const unfreezeAccount = async ({
    userId,
    reason,
    actorId = null,
    actorRole = null,
    scope = null,
    transaction = null
}) => {
    if (!reason || String(reason).trim().length < 3) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST || 400, 'A release reason is required.');
    }

    const where = { userId, status: 'ACTIVE' };
    if (scope) where.scope = scope;

    const freezes = await AccountFreeze.findAll({ where, transaction });
    if (freezes.length === 0) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, 'No active freeze found for this account.');
    }

    for (const freeze of freezes) {
        freeze.status = 'RELEASED';
        freeze.releasedById = actorId;
        freeze.releasedAt = new Date();
        freeze.releaseReason = String(reason).trim();
        await freeze.save({ transaction });
    }

    await auditSecurity({
        actorId,
        actorRole,
        action: 'ACCOUNT_UNFROZEN',
        entityType: 'user',
        entityId: String(userId),
        description: `All active freezes released (${freezes.length}).`,
        outcome: 'SUCCESS',
        reason,
        before: { status: 'ACTIVE' },
        after: { status: 'RELEASED', released: freezes.length },
        critical: true
    });

    publishSecurityEvent(SECURITY_EVENT.ACCOUNT_UNFROZEN, { userId, released: freezes.length, reason });

    return freezes.map((f) => ({ id: f.uuid, scope: f.scope, status: f.status, releasedAt: f.releasedAt }));
};

/**
 * Administrator review of a hold/block. A reason is mandatory; RELEASE also
 * lifts the account freeze so normal operations can resume.
 */
export const reviewRiskEvent = async ({ riskEventId, action, reason, actorId = null, actorRole = null, correlationId = null }) => {
    if (!reason || String(reason).trim().length < 5) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST || 400, 'A review reason of at least 5 characters is required.');
    }
    const normalized = String(action || '').toUpperCase();
    if (!['RELEASE', 'CONFIRM', 'ESCALATE'].includes(normalized)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST || 400, 'action must be one of RELEASE, CONFIRM or ESCALATE.');
    }

    const riskEvent = await RiskEvent.findOne({ where: { uuid: riskEventId } });
    if (!riskEvent) throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, 'Risk event not found.');
    if (['RESOLVED', 'DISMISSED'].includes(riskEvent.status)) {
        throw new ApiError(HTTP_STATUS.CONFLICT || 409, 'This risk event has already been reviewed.');
    }

    riskEvent.reviewedById = actorId;
    riskEvent.reviewDecision = normalized;
    riskEvent.reviewReason = String(reason).trim();
    riskEvent.reviewedAt = new Date();
    riskEvent.status = normalized === 'ESCALATE' ? 'UNDER_REVIEW' : 'RESOLVED';
    await riskEvent.save();

    let released = null;
    if (normalized === 'RELEASE') {
        const active = await AccountFreeze.findAll({ where: { userId: riskEvent.userId, status: 'ACTIVE' } });
        released = [];
        for (const freeze of active) {
            freeze.status = 'RELEASED';
            freeze.releasedById = actorId;
            freeze.releasedAt = new Date();
            freeze.releaseReason = `Released via risk review: ${reason}`;
            await freeze.save();
            released.push(freeze.uuid);
        }
    }

    if (normalized === 'ESCALATE') {
        await openIncidentIfNeeded({
            userId: riskEvent.userId,
            title: `Escalated risk event (${riskEvent.riskLevel})`,
            description: reason,
            severity: riskEvent.riskLevel,
            correlationId: riskEvent.correlationId,
            riskEventId: riskEvent.id,
            actorId
        });
    }

    await auditSecurity({
        actorId,
        actorRole,
        action: `RISK_REVIEW_${normalized}`,
        entityType: 'risk_event',
        entityId: riskEvent.uuid,
        description: `Administrator ${normalized.toLowerCase()}ed risk event.`,
        outcome: 'SUCCESS',
        reason,
        correlationId: correlationId || riskEvent.correlationId,
        before: { status: 'OPEN' },
        after: { status: riskEvent.status, released },
        critical: true
    });

    publishSecurityEvent(SECURITY_EVENT.REVIEW_RECORDED, {
        riskEventId: riskEvent.uuid,
        action: normalized,
        userId: riskEvent.userId,
        reason
    });

    return {
        riskEventId: riskEvent.uuid,
        status: riskEvent.status,
        reviewDecision: riskEvent.reviewDecision,
        releasedFreezes: released
    };
};

/**
 * Security overview metrics. Everything here is derived from real stored rows —
 * no hard-coded counts.
 */
export const buildSecurityOverview = async ({ integrityChecks = true } = {}) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
        openAlerts,
        highRiskToday,
        blockedToday,
        totalToday,
        activeFreezes,
        openIncidents,
        recentIncidents,
        webhookFailures,
        authEvents
    ] = await Promise.all([
        RiskEvent.count({ where: { status: 'OPEN', decision: { [Op.in]: ['HOLD', 'BLOCK'] } } }),
        RiskEvent.count({ where: { createdAt: { [Op.gte]: since }, riskLevel: { [Op.in]: ['HIGH', 'CRITICAL'] } } }),
        RiskEvent.count({ where: { createdAt: { [Op.gte]: since }, decision: { [Op.in]: ['HOLD', 'BLOCK'] } } }),
        RiskEvent.count({ where: { createdAt: { [Op.gte]: since } } }),
        AccountFreeze.count({ where: { status: 'ACTIVE' } }),
        SecurityIncident.count({ where: { status: { [Op.in]: ['OPEN', 'INVESTIGATING'] } } }),
        SecurityIncident.findAll({ order: [['id', 'DESC']], limit: 5 }),
        ProviderWebhookEvent.count({
            where: {
                createdAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
                status: { [Op.in]: ['INVALID_SIGNATURE', 'REJECTED', 'INVALID'] }
            }
        }).catch(() => 0),
        AuditLog.count({
            where: {
                createdAt: { [Op.gte]: since },
                action: { [Op.like]: 'AUTH_%' }
            }
        }).catch(() => 0)
    ]);

    const overview = {
        generatedAt: new Date().toISOString(),
        risk: {
            openAlerts,
            highRiskToday,
            blockedToday,
            evaluatedToday: totalToday
        },
        freezes: { active: activeFreezes },
        incidents: {
            open: openIncidents,
            recent: recentIncidents.map((i) => ({
                id: i.uuid,
                title: i.title,
                severity: i.severity,
                status: i.status,
                createdAt: i.createdAt
            }))
        },
        webhooks: { verificationFailures7d: webhookFailures },
        auth: { securityEvents24h: authEvents },
        integrity: null,
        ledger: null
    };

    if (integrityChecks) {
        try {
            overview.integrity = await verifyAuditChainFromDb({ limit: 500 });
        } catch (error) {
            logger.warn(`Audit integrity check failed: ${error.message}`);
            overview.integrity = { valid: null, error: 'integrity check unavailable' };
        }
        try {
            overview.ledger = await runInvariantChecks();
        } catch (error) {
            logger.warn(`Ledger invariant check failed: ${error.message}`);
            overview.ledger = { ok: null, error: 'ledger check unavailable' };
        }
    }

    return overview;
};

/**
 * Ordered incident timeline assembled from risk events, freezes and the audit
 * trail. Sensitive fields are not selected, so nothing sensitive can leak.
 */
export const getIncidentTimeline = async (incidentUuid) => {
    const incident = await SecurityIncident.findOne({ where: { uuid: incidentUuid } });
    if (!incident) throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, 'Incident not found.');

    const [events, freezes, audits] = await Promise.all([
        RiskEvent.findAll({ where: { incidentId: incident.id }, order: [['id', 'ASC']] }),
        AccountFreeze.findAll({ where: { userId: incident.primaryUserId }, order: [['id', 'ASC']] }),
        incident.correlationId
            ? AuditLog.findAll({ where: { correlationId: incident.correlationId }, order: [['id', 'ASC']] })
            : Promise.resolve([])
    ]);

    const timeline = [
        ...events.map((e) => ({
            at: e.createdAt,
            type: 'RISK_EVALUATION',
            title: `${e.decision} (score ${e.riskScore}, ${e.riskLevel})`,
            detail: (e.explanations || []).join(' | '),
            blocked: ['HOLD', 'BLOCK'].includes(e.decision),
            correlationId: e.correlationId
        })),
        ...freezes.map((f) => ({
            at: f.frozenAt,
            type: f.status === 'ACTIVE' ? 'ACCOUNT_FROZEN' : 'ACCOUNT_RELEASED',
            title: `Freeze ${f.status} (${f.scope})`,
            detail: f.status === 'ACTIVE' ? f.reason : f.releaseReason,
            blocked: f.status === 'ACTIVE',
            correlationId: f.correlationId
        })),
        ...audits.map((a) => ({
            at: a.createdAt,
            type: 'AUDIT',
            title: a.action,
            detail: a.description,
            outcome: a.outcome,
            blocked: a.outcome === 'BLOCKED',
            auditId: a.uuid,
            correlationId: a.correlationId
        }))
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    return {
        incident: {
            id: incident.uuid,
            title: incident.title,
            description: incident.description,
            severity: incident.severity,
            status: incident.status,
            correlationId: incident.correlationId,
            createdAt: incident.createdAt,
            closedAt: incident.closedAt
        },
        timeline,
        blockedActions: timeline.filter((t) => t.blocked).length
    };
};

/** Paginated, filterable security event / risk event listing. */
export const listRiskEvents = async ({
    limit = 25,
    offset = 0,
    decision = null,
    riskLevel = null,
    status = null,
    userId = null,
    from = null,
    to = null,
    search = null
} = {}) => {
    const where = {};
    if (decision) where.decision = { [Op.in]: String(decision).split(',').map((s) => s.trim().toUpperCase()) };
    if (riskLevel) where.riskLevel = { [Op.in]: String(riskLevel).split(',').map((s) => s.trim().toUpperCase()) };
    if (status) where.status = { [Op.in]: String(status).split(',').map((s) => s.trim().toUpperCase()) };
    if (userId) where.userId = userId;
    if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = new Date(from);
        if (to) where.createdAt[Op.lte] = new Date(to);
    }
    if (search) {
        where[Op.or] = [
            { transactionId: { [Op.like]: `%${search}%` } },
            { correlationId: { [Op.like]: `%${search}%` } }
        ];
    }

    const { rows, count } = await RiskEvent.findAndCountAll({
        where,
        limit: Math.min(Math.max(Number(limit) || 25, 1), 200),
        offset: Math.max(Number(offset) || 0, 0),
        order: [['id', 'DESC']]
    });

    return {
        items: rows.map((r) => ({
            id: r.uuid,
            userId: r.userId,
            transactionId: r.transactionId,
            operation: r.operation,
            amountMinor: Number(r.amountMinor),
            currency: r.currency,
            riskScore: r.riskScore,
            riskLevel: r.riskLevel,
            decision: r.decision,
            status: r.status,
            rules: (r.rulesTriggered || []).map((x) => x.rule),
            explanations: r.explanations || [],
            correlationId: r.correlationId,
            reviewReason: r.reviewReason,
            incidentId: r.incidentId,
            createdAt: r.createdAt
        })),
        total: count
    };
};

export { RiskEvent, AccountFreeze, SecurityIncident };
