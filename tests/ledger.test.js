import test from 'node:test';
import assert from 'node:assert/strict';

import {
    signedDelta,
    validateJournal,
    canApplyDebit,
    availableMinorFor,
    applyEntries,
    computeBalanceFromEntries
} from '../src/securepay/ledger.js';

const wallet = { code: 'RETAILER:1:WALLET', normalBalance: 'CREDIT', balanceMinor: 100_00 };
const cash = { code: 'PLATFORM:CASH', normalBalance: 'DEBIT', balanceMinor: 100_00 };

/* ------------------------- pure journal validation ------------------------ */

test('a balanced two-leg journal is accepted and totals are reported', () => {
    const result = validateJournal([
        { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 2500 },
        { accountCode: cash.code, direction: 'CREDIT', amountMinor: 2500 }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.totalDebitMinor, 2500);
    assert.equal(result.totalCreditMinor, 2500);
});

test('an unbalanced journal is rejected', () => {
    const result = validateJournal([
        { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 2500 },
        { accountCode: cash.code, direction: 'CREDIT', amountMinor: 2400 }
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /Unbalanced journal/);
});

test('a single-legged journal is rejected', () => {
    assert.equal(validateJournal([]).ok, false);
    assert.equal(validateJournal([{ accountCode: wallet.code, direction: 'DEBIT', amountMinor: 10 }]).ok, false);
});

test('floating point amounts are rejected — money is integer minor units only', () => {
    const result = validateJournal([
        { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 10.5 },
        { accountCode: cash.code, direction: 'CREDIT', amountMinor: 10.5 }
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /positive integer/);
});

test('zero or negative amounts are rejected', () => {
    for (const amount of [0, -100]) {
        const result = validateJournal([
            { accountCode: wallet.code, direction: 'DEBIT', amountMinor: amount },
            { accountCode: cash.code, direction: 'CREDIT', amountMinor: amount }
        ]);
        assert.equal(result.ok, false);
    }
});

test('mixing currencies in one journal is rejected', () => {
    const result = validateJournal([
        { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 100, currency: 'INR' },
        { accountCode: cash.code, direction: 'CREDIT', amountMinor: 100, currency: 'USD' }
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /mix currencies/);
});

/* ------------------------------- deltas ---------------------------------- */

test('a posting on the normal side increases the balance, the opposite side decreases it', () => {
    // Wallet is a LIABILITY (normal CREDIT): a credit grows it, a debit shrinks it.
    assert.equal(signedDelta({ direction: 'CREDIT', normalBalance: 'CREDIT', amountMinor: 500 }), 500);
    assert.equal(signedDelta({ direction: 'DEBIT', normalBalance: 'CREDIT', amountMinor: 500 }), -500);

    // Cash is an ASSET (normal DEBIT).
    assert.equal(signedDelta({ direction: 'DEBIT', normalBalance: 'DEBIT', amountMinor: 500 }), 500);
    assert.equal(signedDelta({ direction: 'CREDIT', normalBalance: 'DEBIT', amountMinor: 500 }), -500);
});

/* ------------------------------ funds guard ------------------------------ */

test('the funds guard allows an affordable debit and rejects an unaffordable one', () => {
    assert.equal(canApplyDebit({ availableMinor: 5000, amountMinor: 5000 }).ok, true);
    assert.equal(canApplyDebit({ availableMinor: 5000, amountMinor: 5001 }).ok, false);
    assert.equal(canApplyDebit({ availableMinor: 5000, amountMinor: 5001 }).reason, 'INSUFFICIENT_FUNDS');
    assert.equal(canApplyDebit({ availableMinor: 5000, amountMinor: 0 }).reason, 'INVALID_AMOUNT');
});

test('available balance excludes amounts reserved by holds', () => {
    assert.equal(availableMinorFor({ balanceMinor: 10000, holdMinor: 4000 }), 6000);
    assert.equal(availableMinorFor({ balanceMinor: 10000 }), 10000);
});

/* --------------------------- balance projection -------------------------- */

test('applying a balanced journal moves both legs by the same amount', () => {
    const balances = applyEntries({
        accounts: [wallet, cash],
        entries: [
            { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 4000 },
            { accountCode: cash.code, direction: 'CREDIT', amountMinor: 4000 }
        ]
    });
    assert.equal(balances.get(wallet.code), 6000); // liability 10000 - 4000
    assert.equal(balances.get(cash.code), 6000);   // asset 10000 - 4000 (credited)
});

test('applying entries throws rather than allowing a wallet to overdraw', () => {
    assert.throws(() => applyEntries({
        accounts: [wallet, cash],
        entries: [
            { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 200_00 },
            { accountCode: cash.code, direction: 'CREDIT', amountMinor: 200_00 }
        ]
    }), /Insufficient funds/);
});

test('an account explicitly allowed to go negative (system/settlement) may', () => {
    const balances = applyEntries({
        accounts: [{ ...wallet, allowNegative: true }, { ...cash, allowNegative: true }],
        entries: [
            { accountCode: wallet.code, direction: 'DEBIT', amountMinor: 15000 },
            { accountCode: cash.code, direction: 'CREDIT', amountMinor: 15000 }
        ]
    });
    assert.equal(balances.get(wallet.code), -5000); // 10000 - 15000
    assert.equal(balances.get(cash.code), -5000);
});

test('the recomputed balance equals the sum of signed entry deltas', () => {
    const entries = [
        { direction: 'CREDIT', amountMinor: 10000 },
        { direction: 'CREDIT', amountMinor: 5000 },
        { direction: 'DEBIT', amountMinor: 3000 }
    ];
    assert.equal(computeBalanceFromEntries(entries, wallet), 12000);
});

test('recomputation works on real Sequelize entries, not just plain objects', async () => {
    // Regression: a Sequelize instance keeps attributes in `dataValues`, so
    // `{ ...instance }` silently loses them and every balance recomputed to 0 —
    // which made the ledger integrity check report a false mismatch.
    const { default: LedgerEntry } = await import('../src/models/LedgerEntry.js');

    const entry = LedgerEntry.build({ direction: 'CREDIT', amountMinor: 10000, status: 'POSTED' });

    assert.equal(entry.direction, 'CREDIT', 'attribute access works on the instance');
    assert.equal({ ...entry }.direction, undefined, 'spreading the instance loses the attribute (the pitfall)');

    assert.equal(computeBalanceFromEntries([entry], wallet), 10000);
});

test('recomputation handles a mixed set of real Sequelize entries', async () => {
    const { default: LedgerEntry } = await import('../src/models/LedgerEntry.js');
    const entries = [
        LedgerEntry.build({ direction: 'CREDIT', amountMinor: 10000 }),
        LedgerEntry.build({ direction: 'CREDIT', amountMinor: 5000 }),
        LedgerEntry.build({ direction: 'DEBIT', amountMinor: 3000 })
    ];
    assert.equal(computeBalanceFromEntries(entries, wallet), 12000);
});

/* ------------------------------ concurrency ------------------------------ */

/**
 * Mirrors the row-locking contract enforced by `postJournal`:
 *   - each request acquires the wallet lock (serialised),
 *   - re-reads the *current* balance,
 *   - applies the funds guard,
 *   - writes back before releasing.
 * A naive "read once, then write" implementation lets concurrent requests all
 * pass the check and overdraw; this harness proves the guard cannot.
 */
const makeSerialisedWallet = (startingBalanceMinor) => {
    let balanceMinor = startingBalanceMinor;
    let tail = Promise.resolve();

    const withLock = (fn) => {
        const run = tail.then(fn);
        // Keep the chain alive even if a request rejects.
        tail = run.then(() => undefined, () => undefined);
        return run;
    };

    return {
        get balance() { return balanceMinor; },
        debit(amountMinor) {
            return withLock(() => {
                const guard = canApplyDebit({ availableMinor: balanceMinor, amountMinor });
                if (!guard.ok) return guard.reason;
                balanceMinor -= amountMinor;
                return 'POSTED';
            });
        }
    };
};

test('concurrent debits whose total exceeds the balance cannot overspend it', async () => {
    const starting = 100_00; // ₹100.00
    const walletStore = makeSerialisedWallet(starting);

    // Ten concurrent ₹30.00 debits = ₹300 requested against ₹100 available.
    const results = await Promise.all(
        Array.from({ length: 10 }, () => walletStore.debit(30_00))
    );

    const posted = results.filter((r) => r === 'POSTED').length;
    const rejected = results.filter((r) => r === 'INSUFFICIENT_FUNDS').length;

    assert.equal(posted, 3);       // only ₹90 of ₹100 can be spent at ₹30 each
    assert.equal(rejected, 7);
    assert.equal(walletStore.balance, 10_00);
    assert.ok(walletStore.balance >= 0, 'balance must never become negative');
});

test('concurrent exact-balance debits settle to zero, never below', async () => {
    const walletStore = makeSerialisedWallet(60_00);
    const results = await Promise.all(Array.from({ length: 5 }, () => walletStore.debit(20_00)));
    assert.equal(results.filter((r) => r === 'POSTED').length, 3);
    assert.equal(walletStore.balance, 0);
});
