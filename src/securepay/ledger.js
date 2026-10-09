import crypto from 'crypto';
import pkg from 'sequelize';
const { Op } = pkg;

import sequelize from '../config/db.js';
import LedgerAccount from '../models/LedgerAccount.js';
import LedgerEntry from '../models/LedgerEntry.js';

/**
 * Sandbox double-entry ledger.
 *
 * Design rules (from the SecurePay Lab brief):
 *   - Money is only ever represented as integer **minor units**. No floats.
 *   - Every posted journal has debit total === credit total.
 *   - Posted entries are immutable; corrections are compensating entries.
 *   - Balances move only inside a transaction that holds a row lock, so two
 *     concurrent requests cannot both pass the funds check and overspend.
 *
 * The functions above the "DB-backed service" divider are pure and are the ones
 * exercised by the unit tests; the service functions wrap them with persistence.
 */

/* ------------------------------------------------------------------ *
 * Pure domain logic
 * ------------------------------------------------------------------ */

/**
 * Signed effect of a posting on an account balance, in minor units.
 * A posting on the account's normal side increases the balance; the opposite
 * side decreases it.
 */
export const signedDelta = ({ direction, normalBalance, amountMinor }) => {
    const amount = Math.trunc(Number(amountMinor) || 0);
    return direction === normalBalance ? amount : -amount;
};

/**
 * Validates that a journal is balanced, non-empty, single-currency and uses
 * whole minor units. Returns a result object rather than throwing so callers
 * can turn it into an API error.
 */
export const validateJournal = (entries = []) => {
    if (!Array.isArray(entries) || entries.length === 0) {
        return { ok: false, error: 'A journal must contain at least one entry.' };
    }
    if (entries.length < 2) {
        return { ok: false, error: 'A double-entry journal must contain at least two entries.' };
    }

    let totalDebitMinor = 0;
    let totalCreditMinor = 0;
    const currencies = new Set();

    for (const entry of entries) {
        const amount = Number(entry.amountMinor);
        if (!Number.isInteger(amount) || amount <= 0) {
            return { ok: false, error: `Entry amount must be a positive integer in minor units (got ${entry.amountMinor}).` };
        }
        if (entry.direction !== 'DEBIT' && entry.direction !== 'CREDIT') {
            return { ok: false, error: `Entry direction must be DEBIT or CREDIT (got ${entry.direction}).` };
        }
        currencies.add(entry.currency || 'INR');
        if (entry.direction === 'DEBIT') totalDebitMinor += amount;
        else totalCreditMinor += amount;
    }

    if (currencies.size > 1) {
        return { ok: false, error: `A journal may not mix currencies (${[...currencies].join(', ')}).` };
    }

    if (totalDebitMinor !== totalCreditMinor) {
        return {
            ok: false,
            error: `Unbalanced journal: debits ${totalDebitMinor} != credits ${totalCreditMinor} (minor units).`
        };
    }

    return { ok: true, totalDebitMinor, totalCreditMinor };
};

/**
 * The funds guard. Shared by the pure tests and mirrored by the row-locked
 * conditional check inside `postJournal`, so the rule cannot drift.
 */
export const canApplyDebit = ({ availableMinor, amountMinor }) => {
    const available = Math.trunc(Number(availableMinor) || 0);
    const amount = Math.trunc(Number(amountMinor) || 0);
    if (amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
    if (available < amount) return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
    return { ok: true };
};

/** Available = posted balance minus anything reserved by holds. */
export const availableMinorFor = (account) =>
    Math.trunc(Number(account?.balanceMinor || 0)) - Math.trunc(Number(account?.holdMinor || 0));

/**
 * Applies a set of validated entries to an in-memory balance map. Used by tests
 * and by the reconciliation/reporting side. Throws on an overdraft unless the
 * account is explicitly allowed to go negative (system/settlement accounts).
 */
export const applyEntries = ({ accounts, entries }) => {
    const balances = new Map(accounts.map((a) => [a.code, Math.trunc(Number(a.balanceMinor) || 0)]));

    for (const entry of entries) {
        const account = accounts.find((a) => a.code === entry.accountCode);
        if (!account) throw new Error(`Unknown ledger account: ${entry.accountCode}`);
        const delta = signedDelta({ ...entry, normalBalance: account.normalBalance });
        const next = (balances.get(account.code) || 0) + delta;
        if (next < 0 && !account.allowNegative) {
            throw new Error(`Insufficient funds in ${account.code} (balance would become ${next}).`);
        }
        balances.set(account.code, next);
    }

    return balances;
};

/**
 * Signed balance of a set of entries for one account.
 *
 * Fields are read explicitly rather than by spreading the entry: a Sequelize
 * model instance keeps its attributes in `dataValues`, and `{ ...instance }`
 * copies only internal properties (so `direction`/`amountMinor` would be
 * undefined and every balance would recompute to 0). Reading the properties
 * directly works for both plain objects and model instances.
 */
export const computeBalanceFromEntries = (entries, account) =>
    entries.reduce(
        (total, entry) => total + signedDelta({
            direction: entry.direction,
            amountMinor: entry.amountMinor,
            normalBalance: account.normalBalance
        }),
        0
    );

/* ------------------------------------------------------------------ *
 * DB-backed service
 * ------------------------------------------------------------------ */

/**
 * Finds or creates an account by its unique code. Safe to call concurrently —
 * the unique constraint plus the retry on conflict keeps it idempotent.
 */
export const ensureAccount = async ({
    code,
    name = null,
    accountType = 'LIABILITY',
    normalBalance = 'CREDIT',
    currency = 'INR',
    ownerType = null,
    ownerId = null,
    isSystem = false,
    metadata = null,
    transaction = null
}) => {
    const [account] = await LedgerAccount.findOrCreate({
        where: { code },
        defaults: { code, name, accountType, normalBalance, currency, ownerType, ownerId, isSystem, metadata },
        transaction
    });
    return account;
};

/**
 * Posts one balanced journal.
 *
 * All entry rows and every account balance mutation happen inside a single
 * transaction. Accounts are read with `FOR UPDATE` so concurrent journals
 * touching the same wallet serialise instead of racing past the funds check.
 *
 * @returns {Promise<{journalId:string, entries:Array, totals:{debitMinor:number, creditMinor:number}}>}
 * @throws {Error} when the journal is unbalanced, an account is missing/frozen,
 *                 or a balance would go negative without `allowNegative`.
 */
export const postJournal = async ({
    transactionRef,
    entries,
    correlationId = null,
    memo = null,
    status = 'POSTED',
    allowNegative = false,
    transaction: externalTransaction = null
}) => {
    if (!transactionRef) throw new Error('postJournal requires an immutable transactionRef.');

    const validation = validateJournal(entries);
    if (!validation.ok) throw new Error(validation.error);

    const run = async (transaction) => {
        const journalId = crypto.randomUUID();
        const now = new Date();
        const created = [];

        // Deterministic lock order avoids deadlocks between concurrent journals
        // that touch the same pair of accounts in a different order.
        const orderedCodes = [...new Set(entries.map((e) => e.accountCode))].sort();

        const locked = new Map();
        for (const code of orderedCodes) {
            const account = await LedgerAccount.findOne({
                where: { code },
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            if (!account) throw new Error(`Unknown ledger account: ${code}`);
            if (account.isFrozen) throw new Error(`Ledger account ${code} is frozen.`);
            locked.set(code, account);
        }

        // Apply in memory first so an overdraft aborts before anything is written.
        const projected = new Map(
            orderedCodes.map((code) => [code, availableMinorFor(locked.get(code))])
        );

        for (const entry of entries) {
            const account = locked.get(entry.accountCode);
            const delta = signedDelta({ ...entry, normalBalance: account.normalBalance });
            const next = (projected.get(entry.accountCode) || 0) + delta;

            if (next < 0 && !allowNegative) {
                throw new Error(`Insufficient available funds in ${entry.accountCode}: balance would become ${next} minor units.`);
            }
            projected.set(entry.accountCode, next);
        }

        for (const entry of entries) {
            const account = locked.get(entry.accountCode);
            const delta = signedDelta({ ...entry, normalBalance: account.normalBalance });

            const row = await LedgerEntry.create({
                journalId,
                transactionRef,
                accountId: account.id,
                direction: entry.direction,
                amountMinor: Math.trunc(entry.amountMinor),
                currency: entry.currency || account.currency,
                status,
                correlationId,
                memo: entry.memo || memo,
                postedAt: status === 'POSTED' ? now : null,
                metadata: entry.metadata || null
            }, { transaction });

            if (status === 'POSTED') {
                account.balanceMinor = Math.trunc(account.balanceMinor) + delta;
                await account.save({ transaction });
            }

            created.push(row);
        }

        return {
            journalId,
            totals: { debitMinor: validation.totalDebitMinor, creditMinor: validation.totalCreditMinor },
            entries: created
        };
    };

    if (externalTransaction) return run(externalTransaction);
    return sequelize.transaction(run);
};

/**
 * Corrects a journal by posting its exact mirror image. The original entries are
 * never touched.
 */
export const reverseJournal = async ({ journalId, reason = 'Compensating entry', transaction: externalTransaction = null }) => {
    const run = async (transaction) => {
        const original = await LedgerEntry.findAll({
            where: { journalId, status: 'POSTED' },
            include: [{ model: LedgerAccount, as: 'Account' }],
            transaction
        });

        if (original.length === 0) throw new Error(`No posted entries found for journal ${journalId}.`);

        const reversed = await LedgerEntry.findAll({
            where: { transactionRef: { [Op.like]: `REVERSAL:${journalId}%` } },
            transaction
        });
        if (reversed.length > 0) {
            throw new Error(`Journal ${journalId} has already been reversed.`);
        }

        const entries = original.map((entry) => ({
            accountCode: entry.Account.code,
            direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
            amountMinor: Number(entry.amountMinor),
            currency: entry.currency,
            memo: reason
        }));

        return postJournal({
            transactionRef: `REVERSAL:${journalId}`,
            entries,
            memo: reason,
            transaction
        });
    };

    if (externalTransaction) return run(externalTransaction);
    return sequelize.transaction(run);
};

/**
 * Recomputes an account balance from its posted entries and compares it with the
 * cached projection. A mismatch means someone wrote directly to the cache.
 */
export const verifyAccountBalance = async (code, { transaction = null } = {}) => {
    const account = await LedgerAccount.findOne({ where: { code }, transaction });
    if (!account) throw new Error(`Unknown ledger account: ${code}`);

    const entries = await LedgerEntry.findAll({
        where: { accountId: account.id, status: 'POSTED' },
        transaction
    });

    const recomputed = computeBalanceFromEntries(entries, account);
    return {
        code,
        cachedBalanceMinor: Number(account.balanceMinor),
        recomputedBalanceMinor: recomputed,
        consistent: recomputed === Number(account.balanceMinor)
    };
};

/**
 * Ledger-wide invariant checks. Used by the Security Center "ledger integrity"
 * action and by the test report. Every journal must be balanced and every cached
 * balance must equal the sum of its entries.
 */
export const runInvariantChecks = async ({ transactionRef = null, transaction = null } = {}) => {
    const where = transactionRef ? { transactionRef } : {};

    const rows = await LedgerEntry.findAll({
        attributes: ['journalId', 'direction', 'amountMinor'],
        where,
        raw: true,
        transaction
    });

    const perJournal = new Map();
    for (const row of rows) {
        if (!perJournal.has(row.journalId)) perJournal.set(row.journalId, { debit: 0, credit: 0 });
        const bucket = perJournal.get(row.journalId);
        const amount = Number(row.amountMinor);
        if (row.direction === 'DEBIT') bucket.debit += amount;
        else bucket.credit += amount;
    }

    const unbalanced = [];
    let totalDebitMinor = 0;
    let totalCreditMinor = 0;
    for (const [journalId, bucket] of perJournal) {
        totalDebitMinor += bucket.debit;
        totalCreditMinor += bucket.credit;
        if (bucket.debit !== bucket.credit) unbalanced.push({ journalId, ...bucket });
    }

    const accounts = await LedgerAccount.findAll({ transaction });
    const balanceMismatches = [];
    for (const account of accounts) {
        const check = await verifyAccountBalance(account.code, { transaction });
        if (!check.consistent) balanceMismatches.push(check);
    }

    return {
        journalsChecked: perJournal.size,
        entriesChecked: rows.length,
        totalDebitMinor,
        totalCreditMinor,
        balanced: unbalanced.length === 0,
        unbalancedJournals: unbalanced,
        accountsChecked: accounts.length,
        balanceMismatches,
        balancesConsistent: balanceMismatches.length === 0,
        negativeBalances: accounts.filter((a) => Number(a.balanceMinor) < 0).map((a) => a.code),
        ok: unbalanced.length === 0 && balanceMismatches.length === 0 && accounts.every((a) => Number(a.balanceMinor) >= 0)
    };
};

export const getAccountSummary = async (code) => {
    const account = await LedgerAccount.findOne({ where: { code } });
    if (!account) return null;
    const entries = await LedgerEntry.findAll({
        where: { accountId: account.id },
        order: [['id', 'ASC']]
    });
    return {
        code: account.code,
        name: account.name,
        currency: account.currency,
        balanceMinor: Number(account.balanceMinor),
        holdMinor: Number(account.holdMinor),
        availableMinor: availableMinorFor(account),
        isFrozen: account.isFrozen,
        entryCount: entries.length,
        entries: entries.map((e) => ({
            id: Number(e.id),
            journalId: e.journalId,
            transactionRef: e.transactionRef,
            direction: e.direction,
            amountMinor: Number(e.amountMinor),
            status: e.status,
            postedAt: e.postedAt
        }))
    };
};

