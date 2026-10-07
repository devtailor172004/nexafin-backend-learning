import pkg from 'sequelize';
const { Op } = pkg;

import sequelize from '../config/db.js';
import PineLabsPayment from '../models/PineLabsPayment.js';
import PineLabsOrder from '../models/PineLabsOrder.js';
import ReconciliationRun from '../models/ReconciliationRun.js';
import ReconciliationException from '../models/ReconciliationException.js';
import { writeAuditLog } from './auditLog.js';
import { publishLiveEvent } from './eventBus.js';
import logger from '../utils/logger.js';

/**
 * Reconciliation Center.
 *
 * `reconcile()` is PURE (no database) so every exception type can be unit
 * tested in isolation. `runReconciliation()` loads an internal ledger, obtains
 * a provider report and persists the result.
 *
 * IMPORTANT: there is no real settlement file integration here. When the
 * request asks for a simulated report, the run is stored with
 * `source: 'SIMULATED'` and the exact injected discrepancies are recorded on
 * the run so nobody can mistake it for a reconciled settlement.
 */

export const EXCEPTION_TYPE = Object.freeze({
    AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
    STATUS_MISMATCH: 'STATUS_MISMATCH',
    MISSING_INTERNAL: 'MISSING_INTERNAL',
    MISSING_PROVIDER: 'MISSING_PROVIDER',
    DUPLICATE: 'DUPLICATE',
    SETTLEMENT_MISMATCH: 'SETTLEMENT_MISMATCH'
});

export const SEVERITY_BY_TYPE = Object.freeze({
    AMOUNT_MISMATCH: 'HIGH',
    MISSING_INTERNAL: 'HIGH',
    MISSING_PROVIDER: 'MEDIUM',
    DUPLICATE: 'HIGH',
    STATUS_MISMATCH: 'MEDIUM',
    SETTLEMENT_MISMATCH: 'HIGH'
});

const groupBy = (rows, keyFn) => rows.reduce((map, row) => {
    const key = keyFn(row);
    if (!key) return map;
    if (!map[key]) map[key] = [];
    map[key].push(row);
    return map;
}, {});

/** Normalizes a local payment into a comparable ledger row. */
export const normalizeInternalRow = (payment) => ({
    matchKey: payment.merchantPaymentReference || `local:${payment.id}`,
    internalPaymentId: payment.id,
    internalOrderId: payment.orderId,
    merchantPaymentReference: payment.merchantPaymentReference || null,
    providerPaymentId: payment.nxPayPaymentId || null,
    amount: Number(payment.amount),
    status: payment.status,
    currency: payment.currency,
    settledAmount: payment.capturedAt ? Number(payment.captureAmount ?? 0) / 100 : undefined
});

/** Normalizes a provider report row into a comparable ledger row. */
export const normalizeProviderRow = (row) => ({
    matchKey: row.merchant_payment_reference || row.merchantPaymentReference || `provider:${row.id}`,
    providerPaymentId: row.id || row.providerPaymentId || null,
    merchantPaymentReference: row.merchant_payment_reference || row.merchantPaymentReference || null,
    amount: Number(row.amount ?? row.payment_amount?.value / 100 ?? 0),
    status: String(row.status || '').toUpperCase(),
    settledAmount: row.settled_amount !== undefined ? Number(row.settled_amount) : undefined
});

/**
 * PURE matcher: internal ledger vs provider report.
 *
 * @returns {{matches:Array, exceptions:Array, summary:Object}}
 */
export const reconcile = ({ internalRows = [], providerRows = [] } = {}) => {
    const matches = [];
    const exceptions = [];

    const internalMap = groupBy(internalRows, (row) => row.matchKey);
    const providerMap = groupBy(providerRows, (row) => row.matchKey);
    const keys = [...new Set([...Object.keys(internalMap), ...Object.keys(providerMap)])];

    const push = (type, { internal = null, provider = null, details = null } = {}) => {
        const amountDifference = (internal && provider &&
            Number.isFinite(Number(internal.amount)) && Number.isFinite(Number(provider.amount)))
            ? Number((Number(internal.amount) - Number(provider.amount)).toFixed(2))
            : null;

        exceptions.push({
            type,
            severity: SEVERITY_BY_TYPE[type] || 'MEDIUM',
            matchKey: internal?.matchKey || provider?.matchKey || null,
            merchantPaymentReference: internal?.merchantPaymentReference || provider?.merchantPaymentReference || null,
            providerPaymentId: provider?.providerPaymentId || internal?.providerPaymentId || null,
            internalPaymentId: internal?.internalPaymentId ?? null,
            internalOrderId: internal?.internalOrderId ?? null,
            expectedAmount: internal ? internal.amount : null,
            actualAmount: provider ? provider.amount : null,
            expectedStatus: internal ? internal.status : null,
            actualStatus: provider ? provider.status : null,
            amountDifference,
            details
        });
    };

    for (const key of keys) {
        const internalMatches = internalMap[key] || [];
        const providerMatches = providerMap[key] || [];

        // Duplicate on either side takes precedence: comparing a duplicated row
        // would produce noise instead of the root cause.
        if (internalMatches.length > 1 || providerMatches.length > 1) {
            push(EXCEPTION_TYPE.DUPLICATE, {
                internal: internalMatches[0] || null,
                provider: providerMatches[0] || null,
                details: {
                    internalCount: internalMatches.length,
                    providerCount: providerMatches.length,
                    side: providerMatches.length > 1 ? 'PROVIDER' : 'INTERNAL'
                }
            });
            continue;
        }

        const internal = internalMatches[0] || null;
        const provider = providerMatches[0] || null;

        if (internal && !provider) {
            push(EXCEPTION_TYPE.MISSING_PROVIDER, { internal });
            continue;
        }

        if (!internal && provider) {
            push(EXCEPTION_TYPE.MISSING_INTERNAL, { provider });
            continue;
        }

        let matched = true;

        if (Number(internal.amount) !== Number(provider.amount)) {
            push(EXCEPTION_TYPE.AMOUNT_MISMATCH, { internal, provider });
            matched = false;
        }

        if (String(internal.status || '').toUpperCase() !== String(provider.status || '').toUpperCase()) {
            push(EXCEPTION_TYPE.STATUS_MISMATCH, { internal, provider });
            matched = false;
        }

        if (provider.settledAmount !== undefined && internal.settledAmount !== undefined &&
            Number(provider.settledAmount) !== Number(internal.settledAmount)) {
            push(EXCEPTION_TYPE.SETTLEMENT_MISMATCH, {
                internal,
                provider,
                details: {
                    internalSettledAmount: internal.settledAmount,
                    providerSettledAmount: provider.settledAmount
                }
            });
            matched = false;
        }

        if (matched) {
            matches.push({ matchKey: key, internal, provider });
        }
    }

    const summary = exceptions.reduce((acc, exception) => {
        acc[exception.type] = (acc[exception.type] || 0) + 1;
        return acc;
    }, {});

    return { matches, exceptions, summary };
};

/**
 * Builds a provider report shaped like a real settlement file.
 *
 * Because no real provider settlement file is connected, discrepancies are
 * deliberately injected on DISTINCT rows (so each produces a different
 * exception type) and the injected changes are returned for transparency.
 */
export const buildSimulatedProviderReport = (internalRows = [], { inject = true } = {}) => {
    const rows = internalRows.map((row) => ({
        id: row.providerPaymentId || `SIM_${row.matchKey}`,
        merchant_payment_reference: row.matchKey,
        amount: row.amount,
        status: String(row.status || '').toUpperCase(),
        ...(row.settledAmount !== undefined ? { settled_amount: row.settledAmount } : {})
    }));

    if (!inject || rows.length === 0) {
        return { rows, injected: [] };
    }

    const injected = [];
    const usedIndexes = new Set();
    const takeIndex = (preferred) => {
        if (preferred < rows.length && !usedIndexes.has(preferred)) {
            usedIndexes.add(preferred);
            return preferred;
        }
        for (let i = 0; i < rows.length; i += 1) {
            if (!usedIndexes.has(i)) {
                usedIndexes.add(i);
                return i;
            }
        }
        return -1;
    };

    const amountIndex = takeIndex(0);
    if (amountIndex >= 0) {
        rows[amountIndex].amount = Number((rows[amountIndex].amount + 100).toFixed(2));
        injected.push(`AMOUNT_MISMATCH on ${rows[amountIndex].merchant_payment_reference} (+100)`);
    }

    const statusIndex = takeIndex(1);
    if (statusIndex >= 0) {
        const original = rows[statusIndex].status;
        rows[statusIndex].status = original === 'PROCESSED' ? 'FAILED' : 'PROCESSED';
        injected.push(`STATUS_MISMATCH on ${rows[statusIndex].merchant_payment_reference} (${original} -> ${rows[statusIndex].status})`);
    }

    /*
     * A settlement mismatch can only be detected when the internal ledger
     * carries an EXPECTED net settlement to compare against (which needs fee
     * data we do not compute yet). Injecting one otherwise would report a
     * discrepancy that the matcher cannot actually evaluate, so it is skipped.
     */
    const settlementIndex = takeIndex(2);
    if (settlementIndex >= 0 && internalRows[settlementIndex]?.settledAmount !== undefined) {
        const base = rows[settlementIndex].amount;
        rows[settlementIndex].settled_amount = Number((base - 250).toFixed(2));
        injected.push(`SETTLEMENT_MISMATCH on ${rows[settlementIndex].merchant_payment_reference} (net ${rows[settlementIndex].settled_amount})`);
    }

    // Drop a row the provider "never reported".
    const missingProviderIndex = takeIndex(rows.length - 1);
    if (missingProviderIndex >= 0 && rows.length > 3) {
        const [removed] = rows.splice(missingProviderIndex, 1);
        injected.push(`MISSING_PROVIDER for ${removed.merchant_payment_reference} (absent from the report)`);
    }

    // A provider row with no local counterpart.
    if (rows.length > 0) {
        rows.push({
            id: 'SIM_ORPHAN_ROW',
            merchant_payment_reference: `SIM_ORPHAN_${Date.now()}`,
            amount: 1500,
            status: 'PROCESSED'
        });
        injected.push('MISSING_INTERNAL for SIM_ORPHAN_ROW (present only in the report)');
    }

    // A duplicated provider row. This must target a row that no other
    // injection already touched, otherwise the duplicate would mask the
    // original mismatch (duplicate detection takes precedence).
    const duplicateIndex = takeIndex(3);
    if (duplicateIndex >= 0) {
        rows.push({ ...rows[duplicateIndex] });
        injected.push(`DUPLICATE for ${rows[duplicateIndex].merchant_payment_reference} (reported twice)`);
    }

    return { rows, injected };
};

/**
 * Loads the internal ledger for a period.
 */
export const loadInternalLedger = async ({ provider = 'PINELABS', periodStart, periodEnd }) => {
    const payments = await PineLabsPayment.findAll({
        where: {
            createdAt: { [Op.gte]: periodStart, [Op.lte]: periodEnd }
        },
        order: [['createdAt', 'ASC']]
    });

    return payments.map(normalizeInternalRow);
};

/**
 * Runs a reconciliation and persists the run plus its exceptions.
 *
 * @param {object} params
 * @param {string} [params.provider]
 * @param {Date}   params.periodStart
 * @param {Date}   params.periodEnd
 * @param {boolean}[params.simulate=true] when false, `providerRows` must be supplied
 * @param {Array}  [params.providerRows]  real provider report rows
 * @param {number} [params.actorId]
 */
export const runReconciliation = async ({
    provider = 'PINELABS',
    periodStart,
    periodEnd,
    simulate = true,
    providerRows = null,
    actorId = null
}) => {
    const internalRows = await loadInternalLedger({ provider, periodStart, periodEnd });

    let rawReportRows;
    let injected = [];
    let source;

    if (simulate || !providerRows) {
        const generated = buildSimulatedProviderReport(internalRows, { inject: true });
        rawReportRows = generated.rows;
        injected = generated.injected;
        source = 'SIMULATED';
    } else {
        rawReportRows = providerRows;
        source = 'PROVIDER_REPORT';
    }

    // Both sources are normalized here. The matcher compares NORMALIZED rows
    // (matchKey/amount/status), while a provider report uses snake_case fields.
    const reportRows = rawReportRows.map(normalizeProviderRow);

    const { matches, exceptions, summary } = reconcile({
        internalRows,
        providerRows: reportRows
    });

    const run = await sequelize.transaction(async (transaction) => {
        const createdRun = await ReconciliationRun.create({
            provider,
            periodStart,
            periodEnd,
            status: 'COMPLETED',
            source,
            internalCount: internalRows.length,
            providerCount: reportRows.length,
            matchedCount: matches.length,
            exceptionCount: exceptions.length,
            summary,
            injected,
            triggeredById: actorId,
            startedAt: new Date(),
            completedAt: new Date()
        }, { transaction });

        if (exceptions.length) {
            await ReconciliationException.bulkCreate(
                exceptions.map((exception) => ({
                    runId: createdRun.id,
                    type: exception.type,
                    severity: exception.severity,
                    provider,
                    matchKey: exception.matchKey,
                    merchantPaymentReference: exception.merchantPaymentReference,
                    providerPaymentId: exception.providerPaymentId,
                    internalPaymentId: exception.internalPaymentId,
                    internalOrderId: exception.internalOrderId,
                    expectedAmount: exception.expectedAmount,
                    actualAmount: exception.actualAmount,
                    expectedStatus: exception.expectedStatus,
                    actualStatus: exception.actualStatus,
                    amountDifference: exception.amountDifference,
                    details: exception.details,
                    status: 'OPEN'
                })),
                { transaction }
            );
        }

        return createdRun;
    });

    await writeAuditLog({
        actorId,
        action: 'RECONCILIATION_RUN_CREATED',
        entityType: 'ReconciliationRun',
        entityId: run.uuid,
        description: `Reconciliation (${source}) matched ${matches.length} and raised ${exceptions.length} exception(s).`,
        metadata: { summary, injected }
    });

    publishLiveEvent({
        kind: 'reconciliation.run',
        eventType: 'RECONCILIATION_COMPLETED',
        message: `Reconciliation completed: ${matches.length} matched, ${exceptions.length} exception(s).`,
        metadata: { runId: run.uuid, source, summary }
    });

    logger.info(`Reconciliation ${run.uuid} completed: ${matches.length} matched, ${exceptions.length} exceptions.`);

    return { run, matches, exceptions, summary, injected, source };
};

export { ReconciliationRun, ReconciliationException };
