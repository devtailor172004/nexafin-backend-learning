import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GENESIS_PREV_HASH,
    stableStringify,
    canonicalizeAuditRecord,
    computeAuditHash,
    verifyAuditChain
} from '../src/securepay/auditChain.js';

/** Builds a properly-linked chain from partial records. */
const buildChain = (partials) => {
    const out = [];
    let prevHash = GENESIS_PREV_HASH;
    partials.forEach((partial, index) => {
        const base = {
            sequence: index + 1,
            actorId: 1,
            actorRole: 'Admin',
            action: 'TEST_ACTION',
            entityType: 'payment',
            entityId: `pay-${index + 1}`,
            description: `event ${index + 1}`,
            outcome: 'SUCCESS',
            reason: null,
            source: 'API',
            correlationId: `corr-${index + 1}`,
            requestId: `req-${index + 1}`,
            before: null,
            after: null,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
            ...partial
        };
        const hash = computeAuditHash({ prevHash, record: base });
        out.push({ ...base, prevHash, hash });
        prevHash = hash;
    });
    return out;
};

test('an empty audit log is a valid chain', () => {
    const result = verifyAuditChain([]);
    assert.equal(result.valid, true);
    assert.equal(result.checked, 0);
});

test('a well-formed chain of many records verifies', () => {
    const chain = buildChain([{}, {}, {}, {}, {}]);
    const result = verifyAuditChain(chain);
    assert.equal(result.valid, true);
    assert.equal(result.checked, 5);
    assert.equal(result.firstInvalidIndex, null);
    assert.deepEqual(result.brokenLinks, []);
    assert.deepEqual(result.gaps, []);
});

test('the first record links to GENESIS', () => {
    const [first] = buildChain([{}]);
    assert.equal(first.prevHash, GENESIS_PREV_HASH);
    assert.equal(verifyAuditChain([first]).valid, true);
});

test('a modified record is detected and located', () => {
    const chain = buildChain([{}, {}, {}, {}]);
    chain[2].description = 'tampered description';

    const result = verifyAuditChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.firstInvalidIndex, 2);
    assert.equal(result.firstInvalidSequence, 3);
    assert.equal(result.reason, 'HASH_MISMATCH');
});

test('a changed amount/outcome is detected', () => {
    const chain = buildChain([{}, {}]);
    chain[1].outcome = 'FAILURE';

    const result = verifyAuditChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'HASH_MISMATCH');
    assert.equal(result.firstInvalidIndex, 1);
});

test('a privileged attacker who also rewrites the hash is caught by the next link', () => {
    const chain = buildChain([{}, {}, {}]);

    // Attacker edits record 1 and recomputes its own hash so it "looks" valid.
    chain[1].description = 'rewritten by attacker';
    chain[1].hash = computeAuditHash({ prevHash: chain[1].prevHash, record: chain[1] });

    const result = verifyAuditChain(chain);
    assert.equal(result.valid, false);
    // Record 1 now hashes correctly, but record 2 still points at the old hash.
    assert.equal(result.firstInvalidIndex, 2);
    assert.equal(result.reason, 'BROKEN_LINK');
    assert.ok(result.brokenLinks.length >= 1);
});

test('deleting a record in the middle is reported as a gap and a broken link', () => {
    const chain = buildChain([{}, {}, {}, {}]);
    const withHole = [chain[0], chain[1], chain[3]];

    const result = verifyAuditChain(withHole);
    assert.equal(result.valid, false);
    assert.equal(result.gaps.length, 1);
    // Sequence 3 is missing: the next surviving record is 4.
    assert.equal(result.gaps[0].expected, 3);
    assert.equal(result.gaps[0].actual, 4);
    assert.ok(result.brokenLinks.length >= 1);
    assert.equal(result.reason, 'BROKEN_LINK');
});

test('a record with a forged but wrong sequence gap is reported', () => {
    const chain = buildChain([{}, {}, {}]);
    chain[2].sequence = 9; // pretend records 4..8 never existed
    const result = verifyAuditChain(chain);
    assert.equal(result.valid, false);
    assert.ok(result.gaps.some((g) => g.expected === 3 && g.actual === 9));
});

test('reordering two records breaks the chain', () => {
    const chain = buildChain([{}, {}, {}]);
    const swapped = [chain[1], chain[0], chain[2]];
    const result = verifyAuditChain(swapped);
    assert.equal(result.valid, false);
});

test('the canonical form is independent of object key order', () => {
    const a = { action: 'X', actorId: 1, before: { b: 2, a: 1 } };
    const b = { before: { a: 1, b: 2 }, actorId: 1, action: 'X' };
    assert.equal(canonicalizeAuditRecord(a), canonicalizeAuditRecord(b));
});

test('stableStringify sorts keys recursively', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('non-canonical metadata does not affect the hash', () => {
    const record = { sequence: 1, action: 'X', createdAt: '2026-01-01T00:00:00.000Z' };
    const withExtra = { ...record, somethingNew: 'ignored' };
    assert.equal(
        computeAuditHash({ prevHash: GENESIS_PREV_HASH, record }),
        computeAuditHash({ prevHash: GENESIS_PREV_HASH, record: withExtra })
    );
});

test('a different previous hash produces a different hash', () => {
    const record = { sequence: 1, action: 'X', createdAt: '2026-01-01T00:00:00.000Z' };
    assert.notEqual(
        computeAuditHash({ prevHash: 'aaa', record }),
        computeAuditHash({ prevHash: 'bbb', record })
    );
});

test('the verifier reports the number of records it actually checked', () => {
    const chain = buildChain([{}, {}, {}, {}, {}, {}]);
    assert.equal(verifyAuditChain(chain).checked, 6);
});
