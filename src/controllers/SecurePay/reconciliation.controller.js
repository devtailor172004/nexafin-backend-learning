import pkg from 'sequelize';
const { Op, fn, col } = pkg;

import User from '../../models/User.js';
import ReconciliationRun from '../../models/ReconciliationRun.js';
import ReconciliationException from '../../models/ReconciliationException.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../utils/httpStatus.js';
import { getPaginationParams, formatPaginatedResponse } from '../../utils/paginationHelper.js';
import { writeAuditLog } from '../../securepay/auditLog.js';
import { runReconciliation, EXCEPTION_TYPE } from '../../securepay/reconciliation.js';
import { getClientIp } from '../../utils/getClientIp.js';

const EXCEPTION_STATUS = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED'];

const startOf = (value, fallbackDaysAgo) => {
    if (value) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const date = new Date();
    date.setDate(date.getDate() - fallbackDaysAgo);
    date.setHours(0, 0, 0, 0);
    return date;
};

/**
 * @desc    Run a reconciliation (internal ledger vs provider report)
 * @route   POST /api/securepay/reconciliation/runs
 * @access  Private (Admin)
 */
export const createReconciliationRun = asyncHandler(async (req, res) => {
    const {
        provider = 'PINELABS',
        periodStart,
        periodEnd,
        simulate
    } = req.body || {};

    const from = startOf(periodStart, 1);
    const to = periodEnd ? startOf(periodEnd, 0) : new Date();

    if (to <= from) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'periodEnd must be after periodStart.');
    }

    // There is no real settlement file integration, so runs are simulated by
    // default and recorded with source=SIMULATED.
    const shouldSimulate = simulate === undefined ? true : Boolean(simulate);

    const { run, matches, exceptions, summary, injected, source } = await runReconciliation({
        provider: String(provider).toUpperCase(),
        periodStart: from,
        periodEnd: to,
        simulate: shouldSimulate,
        actorId: req.user?.id ?? null
    });

    return res.status(HTTP_STATUS.CREATED).json(
        new ApiResponse(HTTP_STATUS.CREATED, {
            run: {
                uuid: run.uuid,
                provider: run.provider,
                status: run.status,
                source,
                periodStart: run.periodStart,
                periodEnd: run.periodEnd,
                internalCount: run.internalCount,
                providerCount: run.providerCount,
                matchedCount: run.matchedCount,
                exceptionCount: run.exceptionCount,
                completedAt: run.completedAt
            },
            summary,
            injected,
            exceptionCount: exceptions.length,
            matches: matches.length
        }, source === 'SIMULATED'
            ? 'Reconciliation completed using a SIMULATED provider report (no real settlement file is connected).'
            : 'Reconciliation completed.')
    );
});

/**
 * @desc    List reconciliation runs
 * @route   GET /api/securepay/reconciliation/runs
 * @access  Private (Admin)
 */
export const listReconciliationRuns = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, status } = req.query;
    const { pageNum, limitNum, offset } = getPaginationParams(page, limit, 10, 50);

    const where = {};
    if (status) where.status = String(status).toUpperCase();

    const { count, rows } = await ReconciliationRun.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: limitNum,
        offset
    });

    const runs = rows.map((run) => ({
        uuid: run.uuid,
        provider: run.provider,
        status: run.status,
        source: run.source,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        internalCount: run.internalCount,
        providerCount: run.providerCount,
        matchedCount: run.matchedCount,
        exceptionCount: run.exceptionCount,
        summary: run.summary,
        completedAt: run.completedAt,
        createdAt: run.createdAt
    }));

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            formatPaginatedResponse(count, runs, pageNum, limitNum, 'runs'),
            'Reconciliation runs fetched successfully.'
        )
    );
});

/**
 * @desc    Get one reconciliation run with its exceptions
 * @route   GET /api/securepay/reconciliation/runs/:uuid
 * @access  Private (Admin)
 */
export const getReconciliationRun = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const run = await ReconciliationRun.findOne({ where: { uuid } });
    if (!run) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Reconciliation run not found.');
    }

    const exceptions = await ReconciliationException.findAll({
        where: { runId: run.id },
        order: [['severity', 'ASC'], ['createdAt', 'ASC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            run: {
                uuid: run.uuid,
                provider: run.provider,
                status: run.status,
                source: run.source,
                periodStart: run.periodStart,
                periodEnd: run.periodEnd,
                internalCount: run.internalCount,
                providerCount: run.providerCount,
                matchedCount: run.matchedCount,
                exceptionCount: run.exceptionCount,
                summary: run.summary,
                injected: run.injected,
                completedAt: run.completedAt
            },
            exceptions: exceptions.map(serializeException)
        }, 'Reconciliation run fetched successfully.')
    );
});

const serializeException = (exception) => ({
    uuid: exception.uuid,
    type: exception.type,
    severity: exception.severity,
    status: exception.status,
    provider: exception.provider,
    matchKey: exception.matchKey,
    merchantPaymentReference: exception.merchantPaymentReference,
    providerPaymentId: exception.providerPaymentId,
    internalPaymentId: exception.internalPaymentId,
    expectedAmount: exception.expectedAmount === null ? null : Number(exception.expectedAmount),
    actualAmount: exception.actualAmount === null ? null : Number(exception.actualAmount),
    amountDifference: exception.amountDifference === null ? null : Number(exception.amountDifference),
    expectedStatus: exception.expectedStatus,
    actualStatus: exception.actualStatus,
    details: exception.details,
    assignedToId: exception.assignedToId,
    resolutionNote: exception.resolutionNote,
    resolvedAt: exception.resolvedAt,
    createdAt: exception.createdAt
});

/**
 * @desc    List reconciliation exceptions across runs
 * @route   GET /api/securepay/reconciliation/exceptions
 * @access  Private (Admin)
 */
export const listReconciliationExceptions = asyncHandler(async (req, res) => {
    const { page = 1, limit = 25, status, type, severity, runId } = req.query;
    const { pageNum, limitNum, offset } = getPaginationParams(page, limit, 25, 100);

    const where = {};
    if (status) {
        const normalized = String(status).toUpperCase();
        if (!EXCEPTION_STATUS.includes(normalized)) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `status must be one of: ${EXCEPTION_STATUS.join(', ')}.`);
        }
        where.status = normalized;
    }
    if (type) {
        const normalized = String(type).toUpperCase();
        if (!Object.values(EXCEPTION_TYPE).includes(normalized)) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `type must be one of: ${Object.values(EXCEPTION_TYPE).join(', ')}.`);
        }
        where.type = normalized;
    }
    if (severity) where.severity = String(severity).toUpperCase();

    if (runId) {
        const run = await ReconciliationRun.findOne({ where: { uuid: runId } });
        if (!run) throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Reconciliation run not found.');
        where.runId = run.id;
    }

    const { count, rows } = await ReconciliationException.findAndCountAll({
        where,
        include: [{ model: ReconciliationRun, as: 'Run', attributes: ['uuid', 'source', 'provider'] }],
        order: [['createdAt', 'DESC']],
        limit: limitNum,
        offset
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            formatPaginatedResponse(count, rows.map((row) => ({
                ...serializeException(row),
                run: row.Run ? { uuid: row.Run.uuid, source: row.Run.source, provider: row.Run.provider } : null
            })), pageNum, limitNum, 'exceptions'),
            'Reconciliation exceptions fetched successfully.'
        )
    );
});

/**
 * @desc    Exception counts by type and status (drives the dashboard)
 * @route   GET /api/securepay/reconciliation/summary
 * @access  Private (Admin)
 */
export const getReconciliationSummary = asyncHandler(async (req, res) => {
    const [byTypeRows, byStatusRows, openSeverityRows, latestRun] = await Promise.all([
        ReconciliationException.findAll({
            attributes: ['type', [fn('COUNT', col('id')), 'count']],
            group: ['type'],
            raw: true
        }),
        ReconciliationException.findAll({
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            group: ['status'],
            raw: true
        }),
        ReconciliationException.findAll({
            attributes: ['severity', [fn('COUNT', col('id')), 'count']],
            where: { status: { [Op.in]: ['OPEN', 'INVESTIGATING'] } },
            group: ['severity'],
            raw: true
        }),
        ReconciliationRun.findOne({ order: [['createdAt', 'DESC']] })
    ]);

    const toMap = (rows, key) => rows.reduce((acc, row) => {
        acc[row[key]] = Number(row.count);
        return acc;
    }, {});

    const byStatus = toMap(byStatusRows, 'status');
    const openCount = (byStatus.OPEN || 0) + (byStatus.INVESTIGATING || 0);

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            implemented: true,
            byType: toMap(byTypeRows, 'type'),
            byStatus,
            openSeverities: toMap(openSeverityRows, 'severity'),
            openExceptions: openCount,
            latestRun: latestRun ? {
                uuid: latestRun.uuid,
                source: latestRun.source,
                status: latestRun.status,
                exceptionCount: latestRun.exceptionCount,
                matchedCount: latestRun.matchedCount,
                completedAt: latestRun.completedAt
            } : null
        }, 'Reconciliation summary fetched successfully.')
    );
});

/**
 * @desc    Move an exception through its workflow (assign / investigate / resolve / ignore)
 * @route   PATCH /api/securepay/reconciliation/exceptions/:uuid
 * @access  Private (Admin)
 */
export const updateReconciliationException = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { action, assignedToId, note } = req.body || {};

    const allowedActions = ['ASSIGN', 'INVESTIGATE', 'RESOLVE', 'IGNORE'];
    const normalizedAction = String(action || '').toUpperCase();

    if (!allowedActions.includes(normalizedAction)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `action must be one of: ${allowedActions.join(', ')}.`);
    }

    const exception = await ReconciliationException.findOne({ where: { uuid } });
    if (!exception) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Reconciliation exception not found.');
    }

    const before = { status: exception.status, assignedToId: exception.assignedToId };

    if (normalizedAction === 'ASSIGN') {
        if (!assignedToId) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'assignedToId is required when assigning an exception.');
        }
        const assignee = await User.findByPk(assignedToId, { attributes: ['id', 'fullName'] });
        if (!assignee) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'The user to assign this exception to was not found.');
        }
        exception.assignedToId = assignee.id;
        if (exception.status === 'OPEN') exception.status = 'INVESTIGATING';
    }

    if (normalizedAction === 'INVESTIGATE') {
        if (['RESOLVED', 'IGNORED'].includes(exception.status)) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Cannot investigate an exception that is already ${exception.status}.`);
        }
        exception.status = 'INVESTIGATING';
    }

    if (normalizedAction === 'RESOLVE' || normalizedAction === 'IGNORE') {
        if (!note || !String(note).trim()) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `A note is required to ${normalizedAction.toLowerCase()} an exception.`);
        }
        exception.status = normalizedAction === 'RESOLVE' ? 'RESOLVED' : 'IGNORED';
        exception.resolutionNote = String(note).trim();
        exception.resolvedById = req.user?.id ?? null;
        exception.resolvedAt = new Date();
    }

    if (note && normalizedAction !== 'RESOLVE' && normalizedAction !== 'IGNORE') {
        exception.resolutionNote = String(note).trim();
    }

    await exception.save();

    await writeAuditLog({
        actorId: req.user?.id ?? null,
        actorRole: req.user?.role ?? null,
        action: `RECONCILIATION_EXCEPTION_${normalizedAction}`,
        entityType: 'ReconciliationException',
        entityId: exception.uuid,
        description: `${normalizedAction} applied to ${exception.type} exception.`,
        before,
        after: { status: exception.status, assignedToId: exception.assignedToId },
        ipAddress: getClientIp(req),
        metadata: { note: exception.resolutionNote }
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, serializeException(exception), `Exception marked as ${exception.status}.`)
    );
});
