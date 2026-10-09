import crypto from 'crypto';
import {
    RISK_LEVEL,
    RISK_DECISION,
    RISK_RULE,
    DEFAULT_FRAUD_CONFIG
} from '../config/fraudConfig.js';

/**
 * Deterministic, explainable fraud-risk engine.
 *
 * Design constraints (from the SecurePay Lab brief):
 *   - No external AI/ML dependency. Every decision is reproducible from the
 *     inputs and the configured thresholds, which makes it unit-testable and
 *     auditable.
 *   - Every evaluation returns the *why*: the rules that fired, their weight,
 *     a human explanation and the evidence that produced them.
 *   - The engine is a pure function of (attempt, context, config). Persistence,
 *     holds, freezes and events live in the service layer that calls it.
 *
 * `context` is an aggregate snapshot supplied by the caller (normally built
 * from indexed queries). Keeping it explicit means the engine can be exercised
 * without a database, and that each signal's provenance is visible.
 *
 * @typedef {object} FraudContext
 * @property {number}  [recentTransactionCount]      money-moving attempts by the retailer inside the velocity window
 * @property {number}  [baselineAvgAmountMinor]      retailer's synthetic average attempt amount (minor units)
 * @property {number}  [beneficiariesAddedRecently]  beneficiaries created inside the burst window
 * @property {number}  [beneficiaryAgeMinutes]       age of the target beneficiary in minutes (null when not applicable)
 * @property {boolean} [beneficiaryVerified]         whether the target beneficiary passed verification
 * @property {number}  [failedAuthAttempts]          consecutive failed authentication / step-up attempts
 * @property {boolean} [newDevice]                   first time this device/session is seen
 * @property {number}  [blockedAttemptsRecently]     prior attempts that were blocked inside the velocity window
 * @property {number}  [distinctBeneficiariesRecently] distinct beneficiaries targeted recently
 * @property {number}  [nowMs]                       evaluation clock (injected for deterministic tests)
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const minorToMajor = (minor) => (Number(minor || 0) / 100).toFixed(2);

/**
 * Score → risk level. Deliberately the same cut-offs as the decision policy so
 * that a HIGH score can never map to an ALLOW decision.
 */
export const riskLevelForScore = (score) => {
    if (score >= 75) return RISK_LEVEL.CRITICAL;
    if (score >= 50) return RISK_LEVEL.HIGH;
    if (score >= 25) return RISK_LEVEL.MEDIUM;
    return RISK_LEVEL.LOW;
};

/**
 * Each rule inspects the attempt + context and, when it fires, contributes
 * points and an explanation. Rules never throw on missing context — an absent
 * signal simply does not fire, so a partially-populated snapshot degrades to a
 * more permissive (never a falsely blocking) evaluation.
 */
const RULES = [
    {
        id: RISK_RULE.VELOCITY,
        evaluate: ({ context, config }) => {
            const count = Number(context.recentTransactionCount || 0);
            const limit = config.thresholds.velocityCount;
            if (count < limit) return null;
            return {
                explanation: `${count} payment attempts in the last ${config.windows.velocityMinutes} minute(s), at or above the configured limit of ${limit}.`,
                evidence: { recentTransactionCount: count, limit, windowMinutes: config.windows.velocityMinutes }
            };
        }
    },
    {
        id: RISK_RULE.HIGH_AMOUNT,
        evaluate: ({ attempt, config }) => {
            const limit = config.thresholds.highAmountMinor;
            if (!Number.isFinite(attempt.amountMinor) || attempt.amountMinor < limit) return null;
            return {
                explanation: `Attempt amount ${attempt.currency || 'INR'} ${minorToMajor(attempt.amountMinor)} is at or above the high-value limit of ${minorToMajor(limit)}.`,
                evidence: { amountMinor: attempt.amountMinor, limitMinor: limit }
            };
        }
    },
    {
        id: RISK_RULE.AMOUNT_ABOVE_BASELINE,
        evaluate: ({ attempt, context, config }) => {
            const baseline = Number(context.baselineAvgAmountMinor || 0);
            if (baseline <= 0 || !Number.isFinite(attempt.amountMinor)) return null;
            const multiplier = attempt.amountMinor / baseline;
            if (multiplier < config.thresholds.baselineMultiplier) return null;
            return {
                explanation: `Attempt amount is ${multiplier.toFixed(1)}x the retailer's synthetic baseline of ${minorToMajor(baseline)}.`,
                evidence: { amountMinor: attempt.amountMinor, baselineAvgAmountMinor: baseline, multiplier: Number(multiplier.toFixed(2)) }
            };
        }
    },
    {
        id: RISK_RULE.BENEFICIARY_BURST,
        evaluate: ({ context, config }) => {
            const added = Number(context.beneficiariesAddedRecently || 0);
            const limit = config.thresholds.beneficiaryBurstCount;
            if (added < limit) return null;
            return {
                explanation: `${added} beneficiaries added in the last ${config.windows.beneficiaryBurstMinutes} minute(s), at or above the configured limit of ${limit}.`,
                evidence: { beneficiariesAddedRecently: added, limit, windowMinutes: config.windows.beneficiaryBurstMinutes }
            };
        }
    },
    {
        id: RISK_RULE.UNVERIFIED_BENEFICIARY,
        evaluate: ({ context }) => {
            if (context.beneficiaryVerified !== false) return null;
            return {
                explanation: 'Target beneficiary has not completed verification.',
                evidence: { beneficiaryVerified: false }
            };
        }
    },
    {
        id: RISK_RULE.NEW_BENEFICIARY,
        evaluate: ({ context }) => {
            const age = context.beneficiaryAgeMinutes;
            if (age === null || age === undefined) return null;
            if (Number(age) > 60) return null;
            return {
                explanation: `Target beneficiary was added ${Math.round(Number(age))} minute(s) ago (within the 60-minute new-beneficiary window).`,
                evidence: { beneficiaryAgeMinutes: Number(age) }
            };
        }
    },
    {
        id: RISK_RULE.FAILED_AUTH_ATTEMPTS,
        evaluate: ({ context, config }) => {
            const attempts = Number(context.failedAuthAttempts || 0);
            const limit = config.thresholds.failedAuthAttempts;
            if (attempts < limit) return null;
            return {
                explanation: `${attempts} consecutive failed authentication/verification attempts, at or above the configured limit of ${limit}.`,
                evidence: { failedAuthAttempts: attempts, limit }
            };
        }
    },
    {
        id: RISK_RULE.NEW_DEVICE,
        evaluate: ({ context }) => {
            if (!context.newDevice) return null;
            return {
                explanation: 'Operation originated from a device/session not previously seen for this retailer.',
                evidence: { newDevice: true }
            };
        }
    },
    {
        id: RISK_RULE.BASELINE_DEVIATION,
        evaluate: ({ context }) => {
            const deviation = Number(context.baselineDeviationPercent);
            if (!Number.isFinite(deviation) || deviation < 150) return null;
            return {
                explanation: `Amount deviates ${deviation.toFixed(0)}% from the retailer's synthetic baseline.`,
                evidence: { baselineDeviationPercent: Number(deviation.toFixed(2)) }
            };
        }
    },
    {
        id: RISK_RULE.REPEAT_AFTER_BLOCK,
        evaluate: ({ context, config }) => {
            const repeats = Number(context.blockedAttemptsRecently || 0);
            const limit = config.thresholds.repeatAfterBlockCount;
            if (repeats < limit) return null;
            return {
                explanation: `This retailer has ${repeats} blocked attempt(s) in the recent window and is attempting another money-moving operation.`,
                evidence: { blockedAttemptsRecently: repeats, limit, windowMinutes: config.windows.velocityMinutes }
            };
        }
    },
    {
        id: RISK_RULE.PATTERN_ANOMALY,
        evaluate: ({ context, config }) => {
            const distinct = Number(context.distinctBeneficiariesRecently || 0);
            const limit = config.thresholds.distinctBeneficiariesRecently;
            if (distinct < limit) return null;
            return {
                explanation: `${distinct} distinct beneficiaries targeted recently, at or above the configured pattern threshold of ${limit}.`,
                evidence: { distinctBeneficiariesRecently: distinct, limit }
            };
        }
    }
];

/**
 * Evaluates one money-moving attempt.
 *
 * @param {object} params
 * @param {object} params.attempt   - { retailerId, transactionId, amountMinor, currency, operation, payoutCapability }
 * @param {FraudContext} [params.context]
 * @param {object} [params.config]  - overrides DEFAULT_FRAUD_CONFIG (see loadFraudConfig)
 * @param {string} [params.correlationId]
 * @returns {{
 *   transactionId: string|null,
 *   retailerId: string|number|null,
 *   operation: string,
 *   amountMinor: number,
 *   currency: string,
 *   riskScore: number,
 *   riskLevel: string,
 *   decision: string,
 *   rulesTriggered: Array<{rule:string,weight:number,explanation:string,evidence:object}>,
 *   explanations: string[],
 *   configVersion: string,
 *   evaluatedAt: string,
 *   correlationId: string
 * }}
 */
export const evaluateRisk = ({ attempt = {}, context = {}, config = DEFAULT_FRAUD_CONFIG, correlationId } = {}) => {
    const normalizedAttempt = {
        retailerId: attempt.retailerId ?? null,
        transactionId: attempt.transactionId ?? null,
        amountMinor: Number.isFinite(attempt.amountMinor) ? Math.trunc(attempt.amountMinor) : 0,
        currency: attempt.currency || 'INR',
        operation: attempt.operation || 'PAYOUT'
    };

    const triggered = [];
    let score = 0;

    for (const rule of RULES) {
        const result = rule.evaluate({ attempt: normalizedAttempt, context, config });
        if (!result) continue;
        const weight = config.weights?.[rule.id] ?? 0;
        score += weight;
        triggered.push({
            rule: rule.id,
            weight,
            explanation: result.explanation,
            evidence: result.evidence
        });
    }

    score = clamp(score, 0, 100);
    const riskLevel = riskLevelForScore(score);
    const decision = decide({ score, triggered, config });

    return {
        transactionId: normalizedAttempt.transactionId,
        retailerId: normalizedAttempt.retailerId,
        operation: normalizedAttempt.operation,
        amountMinor: normalizedAttempt.amountMinor,
        currency: normalizedAttempt.currency,
        riskScore: score,
        riskLevel,
        decision,
        rulesTriggered: triggered,
        explanations: triggered.map((t) => `${t.rule}: ${t.explanation}`),
        configVersion: config.version || DEFAULT_FRAUD_CONFIG.version,
        evaluatedAt: new Date().toISOString(),
        correlationId: correlationId || crypto.randomUUID()
    };
};

/**
 * Decision policy. Order matters:
 *   1. Hard-block rules win outright.
 *   2. Score thresholds: BLOCK >= blockScore, HOLD >= holdScore, STEP_UP >= stepUpScore.
 *   3. Hard step-up rules raise an otherwise-permissive decision to STEP_UP —
 *      they never lower a stronger decision.
 */
export const decide = ({ score, triggered, config = DEFAULT_FRAUD_CONFIG }) => {
    const fired = new Set(triggered.map((t) => t.rule));

    if (config.hardBlockRules.some((rule) => fired.has(rule))) return RISK_DECISION.BLOCK;

    if (score >= config.thresholds.blockScore) return RISK_DECISION.BLOCK;
    if (score >= config.thresholds.holdScore) return RISK_DECISION.HOLD;
    if (score >= config.thresholds.stepUpScore) return RISK_DECISION.STEP_UP;

    if (config.hardStepUpRules.some((rule) => fired.has(rule))) return RISK_DECISION.STEP_UP;

    return RISK_DECISION.ALLOW;
};

/**
 * True when a decision must prevent the money-moving operation from proceeding.
 * ALLOW and STEP_UP let the caller continue (STEP_UP only after verification);
 * HOLD and BLOCK do not.
 */
export const isBlockingDecision = (decision) =>
    decision === RISK_DECISION.HOLD || decision === RISK_DECISION.BLOCK;

export default evaluateRisk;
