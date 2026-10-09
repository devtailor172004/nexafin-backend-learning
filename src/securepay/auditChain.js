import crypto from 'crypto';

/**
 * Tamper-evidence helpers for the audit trail.
 *
 * Each audit record stores a `hash` over a canonical representation of its own
 * fields **plus** the previous record's hash. Rewriting, reordering, deleting or
 * inserting a record therefore breaks the chain from that point onwards, and the
 * verifier reports exactly where.
 *
 * Honest limitation (documented in the README): a hash chain alone cannot stop a
 * privileged attacker with full write access from recomputing the entire chain.
 * Detecting that requires an externally held checkpoint / append-only store.
 */

export const GENESIS_PREV_HASH = 'GENESIS';

/**
 * The field set that participates in the hash. Anything not listed here is
 * metadata that may be added later without invalidating existing chains — but it
 * is also therefore not tamper-evident, so security-relevant fields must be
 * added here deliberately.
 */
export const CANONICAL_FIELDS = [
    'sequence',
    'actorId',
    'actorRole',
    'action',
    'entityType',
    'entityId',
    'description',
    'outcome',
    'reason',
    'source',
    'correlationId',
    'requestId',
    'before',
    'after',
    'createdAt'
];

/**
 * Stable stringify: object keys are sorted recursively so two structurally equal
 * payloads always hash identically regardless of insertion order.
 */
export const stableStringify = (value) => {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};

const toIso = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

/**
 * Builds the canonical payload for one record. Fields absent from the record are
 * normalised to null so a missing field and an explicit null hash the same way.
 */
export const canonicalizeAuditRecord = (record = {}) => {
    const payload = {};
    for (const field of CANONICAL_FIELDS) {
        if (field === 'createdAt') {
            payload[field] = toIso(record.createdAt);
        } else if (field === 'sequence') {
            payload[field] = record.sequence === null || record.sequence === undefined
                ? null
                : Number(record.sequence);
        } else {
            payload[field] = record[field] === undefined ? null : record[field];
        }
    }
    return stableStringify(payload);
};

/**
 * hash = sha256(prevHash || '|' || canonical(record)).
 */
export const computeAuditHash = ({ prevHash, record }) => {
    const canonical = canonicalizeAuditRecord(record);
    return crypto
        .createHash('sha256')
        .update(`${prevHash || GENESIS_PREV_HASH}|${canonical}`)
        .digest('hex');
};

/**
 * Verifies a chain given oldest-first records.
 *
 * @param {Array<object>} records oldest → newest
 * @returns {{
 *   valid: boolean,
 *   checked: number,
 *   firstInvalidIndex: number|null,
 *   firstInvalidSequence: number|null,
 *   reason: string|null,
 *   brokenLinks: Array<{index:number, sequence:number|null}>,
 *   gaps: Array<{index:number, expected:number, actual:number}>
 * }}
 */
export const verifyAuditChain = (records = []) => {
    const brokenLinks = [];
    const gaps = [];
    let firstInvalidIndex = null;
    let firstInvalidSequence = null;
    let reason = null;

    let expectedPrevHash = GENESIS_PREV_HASH;
    let expectedSequence = null;

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const sequence = record.sequence === null || record.sequence === undefined
            ? null
            : Number(record.sequence);

        // 1. Sequence continuity. A gap means a record was deleted or withheld.
        if (sequence !== null) {
            if (expectedSequence !== null && sequence !== expectedSequence) {
                gaps.push({ index, expected: expectedSequence, actual: sequence });
            }
            expectedSequence = sequence + 1;
        }

        // 2. The record must point at its predecessor.
        if ((record.prevHash || GENESIS_PREV_HASH) !== expectedPrevHash) {
            brokenLinks.push({ index, sequence });
            if (firstInvalidIndex === null) {
                firstInvalidIndex = index;
                firstInvalidSequence = sequence;
                reason = 'BROKEN_LINK';
            }
        }

        // 3. The record's own contents must still hash to its stored hash.
        const recomputed = computeAuditHash({ prevHash: record.prevHash || GENESIS_PREV_HASH, record });
        if (recomputed !== record.hash) {
            if (firstInvalidIndex === null) {
                firstInvalidIndex = index;
                firstInvalidSequence = sequence;
                reason = 'HASH_MISMATCH';
            }
        }

        expectedPrevHash = record.hash;
    }

    const valid = brokenLinks.length === 0 && gaps.length === 0 && firstInvalidIndex === null;

    if (valid) reason = null;
    else if (!reason && gaps.length) reason = 'CHAIN_GAP';

    return {
        valid,
        checked: records.length,
        firstInvalidIndex,
        firstInvalidSequence,
        reason,
        brokenLinks,
        gaps
    };
};

export default computeAuditHash;
