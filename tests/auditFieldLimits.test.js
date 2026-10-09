import test from 'node:test';
import assert from 'node:assert/strict';

import { clipToColumn } from '../src/securepay/auditLog.js';

/**
 * Regression guard.
 *
 * A fraud review writes the joined rule explanations into `audit_logs.reason`.
 * That column is VARCHAR(255); before clipping, a long explanation made the
 * (fail-closed) critical audit write throw and aborted the whole operation —
 * which is what broke Fraud Lab scenarios B, C and I.
 */

test('a value longer than the column is clipped to exactly the column width', () => {
    const long = 'R'.repeat(1000);
    assert.equal(clipToColumn(long, 255).length, 255);
});

test('a value that fits is left untouched', () => {
    assert.equal(clipToColumn('short reason', 255), 'short reason');
    assert.equal(clipToColumn('x'.repeat(255), 255).length, 255);
});

test('non-string values pass through unchanged', () => {
    assert.equal(clipToColumn(null, 255), null);
    assert.equal(clipToColumn(undefined, 255), undefined);
    assert.equal(clipToColumn(42, 255), 42);
    assert.deepEqual(clipToColumn({ a: 1 }, 255), { a: 1 });
});

test('joined risk explanations that overflow the reason column are safely clipped', () => {
    // Simulates `evaluation.explanations.join(' | ')` with many rules firing.
    const explanations = Array.from({ length: 11 }, (_, i) =>
        `RULE_${i}: This is a deliberately long explanation for rule number ${i} that pushes the joined string well past the column width.`
    );
    const joined = explanations.join(' | ');
    assert.ok(joined.length > 255, 'precondition: the joined text overflows 255 chars');

    const clipped = clipToColumn(joined, 255);
    assert.equal(clipped.length, 255);
    assert.ok(joined.startsWith(clipped), 'clipping must preserve the leading content');
});
