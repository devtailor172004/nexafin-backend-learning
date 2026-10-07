import test from 'node:test';
import assert from 'node:assert/strict';

import {
    reconcile,
    EXCEPTION_TYPE,
    buildSimulatedProviderReport,
    normalizeInternalRow,
    normalizeProviderRow
} from '../src/securepay/reconciliation.js';

const internal = (overrides = {}) => ({
    matchKey: 'REF_1',
    internalPaymentId: 1,
    internalOrderId: 1,
    merchantPaymentReference: 'REF_1',
    providerPaymentId: 'pl_1',
    amount: 1000,
    status: 'PROCESSED',
    ...overrides
});

const provider = (overrides = {}) => ({
    matchKey: 'REF_1',
    providerPaymentId: 'pl_1',
    merchantPaymentReference: 'REF_1',
    amount: 1000,
    status: 'PROCESSED',
    ...overrides
});

const typesOf = (result) => result.exceptions.map((e) => e.type);

test('identical ledgers produce a match and no exceptions', () => {
    const result = reconcile({ internalRows: [internal()], providerRows: [provider()] });

    assert.equal(result.exceptions.length, 0);
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.summary, {});
});

test('detects an amount mismatch with the difference', () => {
    const result = reconcile({
        internalRows: [internal({ amount: 1000 })],
        providerRows: [provider({ amount: 900 })]
    });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.AMOUNT_MISMATCH]);
    assert.equal(result.matches.length, 0);
    assert.equal(result.exceptions[0].amountDifference, 100);
    assert.equal(result.exceptions[0].severity, 'HIGH');
});

test('detects a status mismatch', () => {
    const result = reconcile({
        internalRows: [internal({ status: 'PROCESSED' })],
        providerRows: [provider({ status: 'FAILED' })]
    });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.STATUS_MISMATCH]);
    assert.equal(result.exceptions[0].expectedStatus, 'PROCESSED');
    assert.equal(result.exceptions[0].actualStatus, 'FAILED');
});

test('reports both amount and status mismatch when both differ', () => {
    const result = reconcile({
        internalRows: [internal({ amount: 1000, status: 'PROCESSED' })],
        providerRows: [provider({ amount: 500, status: 'FAILED' })]
    });

    assert.deepEqual(typesOf(result).sort(), [EXCEPTION_TYPE.AMOUNT_MISMATCH, EXCEPTION_TYPE.STATUS_MISMATCH]);
});

test('detects a payment missing from the provider report', () => {
    const result = reconcile({ internalRows: [internal()], providerRows: [] });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.MISSING_PROVIDER]);
    assert.equal(result.exceptions[0].internalPaymentId, 1);
    assert.equal(result.exceptions[0].severity, 'MEDIUM');
});

test('detects a provider payment missing internally', () => {
    const result = reconcile({ internalRows: [], providerRows: [provider()] });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.MISSING_INTERNAL]);
    assert.equal(result.exceptions[0].providerPaymentId, 'pl_1');
});

test('detects duplicates on the internal side', () => {
    const result = reconcile({
        internalRows: [internal(), internal({ internalPaymentId: 2 })],
        providerRows: [provider()]
    });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.DUPLICATE]);
    assert.equal(result.exceptions[0].details.internalCount, 2);
    assert.equal(result.exceptions[0].details.side, 'INTERNAL');
});

test('detects duplicates on the provider side', () => {
    const result = reconcile({
        internalRows: [internal()],
        providerRows: [provider(), provider()]
    });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.DUPLICATE]);
    assert.equal(result.exceptions[0].details.side, 'PROVIDER');
});

test('duplicate detection takes precedence over field comparison', () => {
    // A duplicated row with a wrong amount should be reported as DUPLICATE only.
    const result = reconcile({
        internalRows: [internal(), internal({ internalPaymentId: 2 })],
        providerRows: [provider({ amount: 5 })]
    });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.DUPLICATE]);
});

test('detects a settlement mismatch when net amounts differ', () => {
    const result = reconcile({
        internalRows: [internal({ settledAmount: 1000 })],
        providerRows: [provider({ settledAmount: 750 })]
    });

    assert.deepEqual(typesOf(result), [EXCEPTION_TYPE.SETTLEMENT_MISMATCH]);
    assert.equal(result.exceptions[0].details.providerSettledAmount, 750);
});

test('skips the settlement comparison when either side has no settlement data', () => {
    const result = reconcile({
        internalRows: [internal()],
        providerRows: [provider({ settledAmount: 750 })]
    });

    assert.equal(result.exceptions.length, 0);
    assert.equal(result.matches.length, 1);
});

test('summary counts every exception by type', () => {
    const result = reconcile({
        internalRows: [internal({ matchKey: 'A' }), internal({ matchKey: 'B', internalPaymentId: 2 })],
        providerRows: [provider({ matchKey: 'A', amount: 1 })]
    });

    assert.equal(result.summary[EXCEPTION_TYPE.MISSING_PROVIDER], 1);
    assert.equal(result.summary[EXCEPTION_TYPE.AMOUNT_MISMATCH], 1);
});

test('the simulated report is deterministic and declares what it injected', () => {
    // settledAmount is present so the settlement comparison is evaluable:
    // without an expected net settlement the matcher cannot detect that type.
    const rows = [
        internal({ matchKey: 'A', settledAmount: 1000 }),
        internal({ matchKey: 'B', internalPaymentId: 2, settledAmount: 1000 }),
        internal({ matchKey: 'C', internalPaymentId: 3, settledAmount: 1000 }),
        internal({ matchKey: 'D', internalPaymentId: 4, settledAmount: 1000 }),
        internal({ matchKey: 'E', internalPaymentId: 5, settledAmount: 1000 })
    ];

    const report = buildSimulatedProviderReport(rows, { inject: true });

    assert.ok(report.injected.length > 0, 'should declare injected discrepancies');
    assert.ok(report.rows.length > 0);
    report.injected.forEach((entry) => {
        assert.equal(typeof entry, 'string');
    });

    // The generator emits provider-report shaped rows; the orchestrator
    // normalizes them before matching, so the test does the same.
    const normalizedReport = report.rows.map(normalizeProviderRow);
    const result = reconcile({ internalRows: rows, providerRows: normalizedReport });
    const types = new Set(typesOf(result));

    assert.equal(types.has(EXCEPTION_TYPE.AMOUNT_MISMATCH), true);
    assert.equal(types.has(EXCEPTION_TYPE.STATUS_MISMATCH), true);
    assert.equal(types.has(EXCEPTION_TYPE.SETTLEMENT_MISMATCH), true);
    assert.equal(types.has(EXCEPTION_TYPE.MISSING_PROVIDER), true);
    assert.equal(types.has(EXCEPTION_TYPE.MISSING_INTERNAL), true);
    assert.equal(types.has(EXCEPTION_TYPE.DUPLICATE), true);
});

test('the simulator does not claim a settlement mismatch it cannot evaluate', () => {
    // No expected net settlement on the internal side -> no such injection.
    const rows = ['A', 'B', 'C', 'D', 'E'].map((key, index) =>
        internal({ matchKey: key, internalPaymentId: index + 1 }));

    const report = buildSimulatedProviderReport(rows, { inject: true });

    assert.equal(
        report.injected.some((entry) => entry.startsWith('SETTLEMENT_MISMATCH')),
        false,
        'must not inject a settlement mismatch when there is nothing to compare against'
    );
});

test('a non-injected report matches the internal ledger exactly', () => {
    const rows = [internal({ matchKey: 'A' }), internal({ matchKey: 'B', internalPaymentId: 2 })];
    const report = buildSimulatedProviderReport(rows, { inject: false });

    const result = reconcile({
        internalRows: rows,
        providerRows: report.rows.map(normalizeProviderRow)
    });

    assert.equal(result.exceptions.length, 0);
    assert.equal(result.matches.length, 2);
});

test('normalizers map database and provider shapes onto comparable rows', () => {
    const normalizedInternal = normalizeInternalRow({
        id: 7,
        orderId: 3,
        merchantPaymentReference: 'REF_X',
        nxPayPaymentId: 'pl_x',
        amount: '250.00',
        status: 'PROCESSED',
        currency: 'INR'
    });

    assert.equal(normalizedInternal.matchKey, 'REF_X');
    assert.equal(normalizedInternal.amount, 250);
    assert.equal(normalizedInternal.internalPaymentId, 7);

    const normalizedProvider = normalizeProviderRow({
        id: 'pl_x',
        merchant_payment_reference: 'REF_X',
        amount: 250,
        status: 'processed'
    });

    assert.equal(normalizedProvider.matchKey, 'REF_X');
    assert.equal(normalizedProvider.status, 'PROCESSED');
});
