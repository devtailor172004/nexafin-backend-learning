import pkg from 'sequelize';
const { Op } = pkg;

import AuditLog from '../models/AuditLog.js';
import sequelize from '../config/db.js';
import logger from '../utils/logger.js';
import { GENESIS_PREV_HASH, computeAuditHash, verifyAuditChain } from './auditChain.js';

/**
 * Writes a centralized, hash-chained audit log entry.
 *
 * Failure policy is explicit:
 *   - `critical: false` (default) — an audit failure is logged loudly but does
 *     NOT abort the caller. Suitable for diagnostic / observability entries.
 *   - `critical: true` — the write happens in the caller's (or its own)
 *     transaction and any failure is re-thrown, so a protected financial
 *     operation rolls back rather than succeeding without its audit record.
 *
 * The `sequence`/`prevHash`/`hash` triple links every new record to its
 * predecessor. A unique index on `sequence` plus a bounded retry on conflict
 * keeps concurrent writers from producing two records with the same position.
 */

const MAX_SEQUENCE_ATTEMPTS = 5;

/**
 * Column widths for the bounded string fields. Values are clipped to fit
 * BEFORE hashing, so an unusually long explanation can never make a critical
 * audit write fail (which, being fail-closed, would roll back the business
 * operation). The full detail always remains on the related RiskEvent.
 */
const FIELD_LIMITS = {
    action: 100,
    actorRole: 50,
    entityType: 50,
    entityId: 100,
    description: 255,
    outcome: 30,
    reason: 255,
    source: 40,
    correlationId: 80,
    requestId: 80,
    ipAddress: 64
};

/** Clips a string to the column width. Non-strings are returned untouched. */
export const clipToColumn = (value, max) =>
    (typeof value === 'string' && value.length > max ? value.slice(0, max) : value);

const clipFields = (fields) => {
    const out = { ...fields };
    for (const [key, max] of Object.entries(FIELD_LIMITS)) {
        out[key] = clipToColumn(out[key], max);
    }
    return out;
};

const isUniqueViolation = (error) => {
    const name = error?.name || '';
    const code = error?.parent?.code || error?.original?.code || error?.code;
    return (
        name === 'SequelizeUniqueConstraintError' ||
        code === '23505' || // Postgres
        code === 'ER_DUP_ENTRY' || // MySQL
        code === 'SQLITE_CONSTRAINT'
    );
};

/**
 * Determines the next chain position and the previous hash.
 * When a transaction is supplied the tip row is locked, which serialises
 * concurrent audit writers onto the same chain.
 */
const nextChainLink = async (transaction) => {
    const tip = await AuditLog.findOne({
        where: { sequence: { [Op.ne]: null } },
        order: [['sequence', 'DESC']],
        attributes: ['sequence', 'hash'],
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined
    });

    if (!tip) return { sequence: 1, prevHash: GENESIS_PREV_HASH };
    return { sequence: Number(tip.sequence) + 1, prevHash: tip.hash };
};

const insertChainedRecord = async (fields, transaction) => {
    let lastError;
    for (let attempt = 0; attempt < MAX_SEQUENCE_ATTEMPTS; attempt += 1) {
        const { sequence, prevHash } = await nextChainLink(transaction);
        const createdAt = new Date();

        const hash = computeAuditHash({
            prevHash,
            record: { ...fields, sequence, createdAt }
        });

        try {
            return await AuditLog.create(
                { ...fields, sequence, prevHash, hash, createdAt },
                { transaction }
            );
        } catch (error) {
            lastError = error;
            if (!isUniqueViolation(error)) throw error;
            // Another writer claimed this sequence; recompute and retry.
            logger.warn(`Audit chain sequence ${sequence} was claimed concurrently; retrying.`);
        }
    }
    throw lastError;
};

export const writeAuditLog = async ({
    actorId = null,
    actorRole = null,
    action,
    entityType = null,
    entityId = null,
    description = null,
    before = null,
    after = null,
    ipAddress = null,
    metadata = null,
    outcome = null,
    reason = null,
    source = null,
    correlationId = null,
    requestId = null,
    critical = false,
    transaction = null
}) => {
    const fields = clipFields({
        actorId,
        actorRole,
        action,
        entityType,
        entityId,
        description,
        before,
        after,
        ipAddress,
        metadata,
        outcome,
        reason,
        source,
        correlationId,
        requestId
    });

    const write = async (tx) => insertChainedRecord(fields, tx);

    try {
        if (transaction) return await write(transaction);
        return await sequelize.transaction(write);
    } catch (error) {
        logger.error(`Audit log write failed for action '${action}': ${error.message}`);

        if (critical) {
            // Re-throw so the enclosing business transaction rolls back.
            throw new Error(`Mandatory audit record could not be persisted for '${action}': ${error.message}`);
        }
        return null;
    }
};

/**
 * Verifies the on-disk audit chain.
 *
 * @param {object} [options]
 * @param {number} [options.limit] - verify at most the newest N chained records
 * @returns {Promise<object>} the verifier result plus chain bounds
 */
export const verifyAuditChainFromDb = async ({ limit = null, transaction = null } = {}) => {
    const where = { sequence: { [Op.ne]: null } };

    const all = await AuditLog.findAll({
        where,
        order: [['sequence', 'ASC']],
        raw: true,
        transaction
    });

    const records = limit && all.length > limit ? all.slice(-limit) : all;
    const result = verifyAuditChain(records);

    return {
        ...result,
        totalChainedRecords: all.length,
        verifiedRange: records.length
            ? { from: Number(records[0].sequence), to: Number(records[records.length - 1].sequence) }
            : null,
        // A hash chain cannot stop a fully privileged attacker recomputing every
        // hash; this is reported so the UI never overstates the guarantee.
        limitation:
            'A hash chain detects modification of stored records but cannot prevent an attacker with full ' +
            'write access from recomputing the whole chain. Anchor the tip hash in an external, append-only ' +
            'store and restrict UPDATE/DELETE grants on audit_logs for stronger tamper evidence.'
    };
};

/** Tip of the chain, useful as a checkpoint to publish externally. */
export const getAuditChainTip = async () => {
    const tip = await AuditLog.findOne({
        where: { sequence: { [Op.ne]: null } },
        order: [['sequence', 'DESC']],
        attributes: ['sequence', 'hash', 'createdAt']
    });
    return tip ? { sequence: Number(tip.sequence), hash: tip.hash, at: tip.createdAt } : null;
};

export default writeAuditLog;
