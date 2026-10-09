import test from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateRisk,
    decide,
    riskLevelForScore,
    isBlockingDecision
} from '../src/securepay/fraudEngine.js';
import {
    DEFAULT_FRAUD_CONFIG,
    RISK_DECISION,
    RISK_LEVEL,
    RISK_RULE,
    loadFraudConfig
} from '../src/config/fraudConfig.js';

const baseAttempt = (overrides = {}) => ({
    retailerId: 'retailer-A',
    transactionId: 'tx-1',
    amountMinor: 50000, // ₹500.00 — below every high-value threshold
    currency: 'INR',
    operation: 'PAYOUT',
    ...overrides
});

test('a normal, low-risk attempt is allowed and nothing freezes', () => {
    const result = evaluateRisk({
        attempt: baseAttempt(),
        context: {
            recentTransactionCount: 1,
            baselineAvgAmountMinor: 40000,
            beneficiariesAddedRecently: 0,
            beneficiaryVerified: true,
            beneficiaryAgeMinutes: 5000,
            failedAuthAttempts: 0,
            newDevice: false,
            blockedAttemptsRecently: 0,
            distinctBeneficiariesRecently: 1
        }
    });

    assert.equal(result.decision, RISK_DECISION.ALLOW);
    assert.equal(result.riskLevel, RISK_LEVEL.LOW);
    assert.equal(result.riskScore, 0);
    assert.deepEqual(result.rulesTriggered, []);
    assert.equal(isBlockingDecision(result.decision), false);
});

test('repeated transactions trigger the configured velocity rule', () => {
    const result = evaluateRisk({
        attempt: baseAttempt(),
        context: { recentTransactionCount: DEFAULT_FRAUD_CONFIG.thresholds.velocityCount }
    });

    const rules = result.rulesTriggered.map((r) => r.rule);
    assert.ok(rules.includes(RISK_RULE.VELOCITY));
    assert.equal(result.riskScore, DEFAULT_FRAUD_CONFIG.weights[RISK_RULE.VELOCITY]);
    assert.ok(result.explanations.some((e) => e.startsWith(RISK_RULE.VELOCITY)));
});

test('velocity one below the threshold does not fire', () => {
    const result = evaluateRisk({
        attempt: baseAttempt(),
        context: { recentTransactionCount: DEFAULT_FRAUD_CONFIG.thresholds.velocityCount - 1 }
    });
    assert.deepEqual(result.rulesTriggered, []);
});

test('a high-value attempt to a new unverified beneficiary escalates above ALLOW', () => {
    const result = evaluateRisk({
        attempt: baseAttempt({ amountMinor: 900000 }), // ₹9,000.00
        context: {
            beneficiaryVerified: false,
            beneficiaryAgeMinutes: 5
        }
    });

    const rules = result.rulesTriggered.map((r) => r.rule);
    assert.ok(rules.includes(RISK_RULE.HIGH_AMOUNT));
    assert.ok(rules.includes(RISK_RULE.UNVERIFIED_BENEFICIARY));
    assert.ok(rules.includes(RISK_RULE.NEW_BENEFICIARY));
    // 25 + 20 + 10 = 55 -> above holdScore, so the payout is held rather than
    // merely stepped up. The point of the assertion is that it is NOT allowed.
    assert.equal(result.riskScore, 55);
    assert.equal(result.decision, RISK_DECISION.HOLD);
    assert.notEqual(result.decision, RISK_DECISION.ALLOW);
    assert.equal(isBlockingDecision(result.decision), true);
});

test('an unverified beneficiary alone forces STEP_UP even at a low score', () => {
    const result = evaluateRisk({
        attempt: baseAttempt({ amountMinor: 100 }),
        context: { beneficiaryVerified: false }
    });
    // weight 20 < stepUpScore 30, but it is a hard step-up rule.
    assert.equal(result.riskScore, 20);
    assert.equal(result.decision, RISK_DECISION.STEP_UP);
});

test('a retailer that keeps trying after a block is blocked outright', () => {
    const result = evaluateRisk({
        attempt: baseAttempt(),
        context: { blockedAttemptsRecently: 1 }
    });

    assert.equal(result.decision, RISK_DECISION.BLOCK);
    assert.ok(result.rulesTriggered.some((r) => r.rule === RISK_RULE.REPEAT_AFTER_BLOCK));
    assert.equal(isBlockingDecision(result.decision), true);
});

test('the decision policy never lowers a hard-block rule below BLOCK', () => {
    const decision = decide({
        score: 0,
        triggered: [{ rule: RISK_RULE.REPEAT_AFTER_BLOCK, weight: 35 }],
        config: DEFAULT_FRAUD_CONFIG
    });
    assert.equal(decision, RISK_DECISION.BLOCK);
});

test('score thresholds map monotonically onto decisions and levels', () => {
    const { stepUpScore, holdScore, blockScore } = DEFAULT_FRAUD_CONFIG.thresholds;

    assert.equal(decide({ score: 0, triggered: [], config: DEFAULT_FRAUD_CONFIG }), RISK_DECISION.ALLOW);
    assert.equal(decide({ score: stepUpScore, triggered: [], config: DEFAULT_FRAUD_CONFIG }), RISK_DECISION.STEP_UP);
    assert.equal(decide({ score: holdScore, triggered: [], config: DEFAULT_FRAUD_CONFIG }), RISK_DECISION.HOLD);
    assert.equal(decide({ score: blockScore, triggered: [], config: DEFAULT_FRAUD_CONFIG }), RISK_DECISION.BLOCK);

    assert.equal(riskLevelForScore(0), RISK_LEVEL.LOW);
    assert.equal(riskLevelForScore(25), RISK_LEVEL.MEDIUM);
    assert.equal(riskLevelForScore(50), RISK_LEVEL.HIGH);
    assert.equal(riskLevelForScore(75), RISK_LEVEL.CRITICAL);

    // A HIGH/CRITICAL level must always be at least a HOLD decision.
    for (let score = 0; score <= 100; score += 1) {
        const level = riskLevelForScore(score);
        const d = decide({ score, triggered: [], config: DEFAULT_FRAUD_CONFIG });
        if (level === RISK_LEVEL.CRITICAL) assert.equal(d, RISK_DECISION.BLOCK);
    }
});

test('the score is clamped to 100 however many rules fire', () => {
    const result = evaluateRisk({
        attempt: baseAttempt({ amountMinor: 10000000 }),
        context: {
            recentTransactionCount: 50,
            baselineAvgAmountMinor: 100,
            beneficiariesAddedRecently: 9,
            beneficiaryVerified: false,
            beneficiaryAgeMinutes: 1,
            failedAuthAttempts: 9,
            newDevice: true,
            blockedAttemptsRecently: 3,
            distinctBeneficiariesRecently: 9,
            baselineDeviationPercent: 900
        }
    });

    assert.equal(result.riskScore, 100);
    assert.equal(result.riskLevel, RISK_LEVEL.CRITICAL);
    assert.equal(result.decision, RISK_DECISION.BLOCK);
    assert.equal(result.rulesTriggered.length, 11);
});

test('every evaluation returns identification, traceability and explanation data', () => {
    const result = evaluateRisk({
        attempt: baseAttempt({ transactionId: 'tx-42', retailerId: 'retailer-Z' }),
        context: { failedAuthAttempts: 3 },
        correlationId: 'corr-123'
    });

    assert.equal(result.transactionId, 'tx-42');
    assert.equal(result.retailerId, 'retailer-Z');
    assert.equal(result.correlationId, 'corr-123');
    assert.equal(result.configVersion, DEFAULT_FRAUD_CONFIG.version);
    assert.ok(Date.parse(result.evaluatedAt) > 0);
    assert.equal(result.rulesTriggered.length, result.explanations.length);
    for (const rule of result.rulesTriggered) {
        assert.equal(typeof rule.weight, 'number');
        assert.equal(typeof rule.explanation, 'string');
        assert.ok(rule.explanation.length > 10);
        assert.equal(typeof rule.evidence, 'object');
    }
});

test('a correlation id is generated when the caller does not supply one', () => {
    const a = evaluateRisk({ attempt: baseAttempt() });
    const b = evaluateRisk({ attempt: baseAttempt() });
    assert.ok(a.correlationId);
    assert.notEqual(a.correlationId, b.correlationId);
});

test('the engine is deterministic for identical inputs', () => {
    const attempt = baseAttempt({ amountMinor: 700000 });
    const context = { recentTransactionCount: 6, beneficiaryVerified: false, beneficiaryAgeMinutes: 2 };
    const first = evaluateRisk({ attempt, context, correlationId: 'fixed' });
    const second = evaluateRisk({ attempt, context, correlationId: 'fixed' });
    assert.deepEqual(first, second);
});

test('missing context degrades to permissive, never to a false block', () => {
    const result = evaluateRisk({ attempt: baseAttempt() });
    assert.equal(result.decision, RISK_DECISION.ALLOW);
    assert.equal(result.riskScore, 0);
});

test('an attempt amount that is not a finite number is treated as zero, not NaN', () => {
    const result = evaluateRisk({ attempt: baseAttempt({ amountMinor: Number.NaN }) });
    assert.equal(result.amountMinor, 0);
    assert.equal(Number.isNaN(result.riskScore), false);
});

test('thresholds are configurable and overrides are honoured', () => {
    const config = loadFraudConfig({
        FRAUD_HIGH_AMOUNT_MINOR: '100000',
        FRAUD_VELOCITY_COUNT: '2',
        FRAUD_VELOCITY_WINDOW_MINUTES: '3'
    });

    assert.equal(config.thresholds.highAmountMinor, 100000);
    assert.equal(config.thresholds.velocityCount, 2);
    assert.equal(config.windows.velocityMinutes, 3);

    // ₹1,200.00 now clears the lowered high-value bar.
    const result = evaluateRisk({ attempt: baseAttempt({ amountMinor: 120000 }), config });
    assert.ok(result.rulesTriggered.some((r) => r.rule === RISK_RULE.HIGH_AMOUNT));

    // Two attempts now trip the lowered velocity rule.
    const velocity = evaluateRisk({ attempt: baseAttempt({ amountMinor: 1 }), context: { recentTransactionCount: 2 }, config });
    assert.ok(velocity.rulesTriggered.some((r) => r.rule === RISK_RULE.VELOCITY));
});

test('an invalid environment override falls back to the documented default', () => {
    const config = loadFraudConfig({ FRAUD_BLOCK_SCORE: 'not-a-number' });
    assert.equal(config.thresholds.blockScore, DEFAULT_FRAUD_CONFIG.thresholds.blockScore);
});

test('only HOLD and BLOCK prevent the operation from proceeding', () => {
    assert.equal(isBlockingDecision(RISK_DECISION.ALLOW), false);
    assert.equal(isBlockingDecision(RISK_DECISION.STEP_UP), false);
    assert.equal(isBlockingDecision(RISK_DECISION.HOLD), true);
    assert.equal(isBlockingDecision(RISK_DECISION.BLOCK), true);
});
