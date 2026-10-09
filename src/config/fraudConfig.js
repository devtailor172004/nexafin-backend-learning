/**
 * Fraud-risk engine configuration.
 *
 * Every threshold the engine uses is declared here — no unexplained magic
 * numbers live inside the rule implementations. Deployments can override any
 * threshold or weight with `FRAUD_*` environment variables (see `loadFraudConfig`)
 * so that tuning never requires a code change and never silently changes the
 * shape of a stored decision.
 *
 * Amounts are expressed in **minor currency units** (paise for INR) to stay
 * consistent with the rest of the ledger, which never uses floating point.
 */

export const RISK_LEVEL = {
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
    CRITICAL: 'CRITICAL'
};

export const RISK_DECISION = {
    ALLOW: 'ALLOW',
    STEP_UP: 'STEP_UP',
    HOLD: 'HOLD',
    BLOCK: 'BLOCK'
};

/**
 * Rule identifiers. These are stable strings — they are persisted on risk
 * events and rendered in the Security Center, so they must not be renamed
 * without a data migration.
 */
export const RISK_RULE = {
    VELOCITY: 'VELOCITY',
    HIGH_AMOUNT: 'HIGH_AMOUNT',
    AMOUNT_ABOVE_BASELINE: 'AMOUNT_ABOVE_BASELINE',
    BENEFICIARY_BURST: 'BENEFICIARY_BURST',
    UNVERIFIED_BENEFICIARY: 'UNVERIFIED_BENEFICIARY',
    NEW_BENEFICIARY: 'NEW_BENEFICIARY',
    FAILED_AUTH_ATTEMPTS: 'FAILED_AUTH_ATTEMPTS',
    NEW_DEVICE: 'NEW_DEVICE',
    BASELINE_DEVIATION: 'BASELINE_DEVIATION',
    REPEAT_AFTER_BLOCK: 'REPEAT_AFTER_BLOCK',
    PATTERN_ANOMALY: 'PATTERN_ANOMALY'
};

export const DEFAULT_FRAUD_CONFIG = Object.freeze({
    version: '1.0.0',
    // Rolling windows used by the aggregation queries that feed the engine.
    windows: {
        velocityMinutes: 10,
        beneficiaryBurstMinutes: 60,
        baselineDays: 30
    },
    thresholds: {
        // Number of money-moving attempts by one retailer inside velocityMinutes.
        velocityCount: 5,
        // Absolute high-value threshold in minor units (₹5,000.00).
        highAmountMinor: 500000,
        // Multiple of the retailer's synthetic baseline that counts as abnormal.
        baselineMultiplier: 4,
        // Beneficiaries created inside beneficiaryBurstMinutes.
        beneficiaryBurstCount: 3,
        // Consecutive failed step-up / login attempts.
        failedAuthAttempts: 3,
        // Re-attempts after a transaction was already blocked.
        repeatAfterBlockCount: 1,
        // Distinct beneficiaries seen in the recent window (pattern anomaly).
        distinctBeneficiariesRecently: 4,
        // Score cut-offs. score is clamped to 0..100.
        stepUpScore: 30,
        holdScore: 50,
        blockScore: 70
    },
    // Points contributed by each triggered rule.
    weights: {
        [RISK_RULE.VELOCITY]: 25,
        [RISK_RULE.HIGH_AMOUNT]: 25,
        [RISK_RULE.AMOUNT_ABOVE_BASELINE]: 15,
        [RISK_RULE.BENEFICIARY_BURST]: 20,
        [RISK_RULE.UNVERIFIED_BENEFICIARY]: 20,
        [RISK_RULE.NEW_BENEFICIARY]: 10,
        [RISK_RULE.FAILED_AUTH_ATTEMPTS]: 20,
        [RISK_RULE.NEW_DEVICE]: 10,
        [RISK_RULE.BASELINE_DEVIATION]: 15,
        [RISK_RULE.REPEAT_AFTER_BLOCK]: 35,
        [RISK_RULE.PATTERN_ANOMALY]: 15
    },
    // Rules that force BLOCK regardless of the aggregate score, because their
    // presence alone indicates deliberate abuse rather than an ambiguous signal.
    hardBlockRules: [RISK_RULE.REPEAT_AFTER_BLOCK],
    // Rules that force at least STEP_UP.
    hardStepUpRules: [RISK_RULE.UNVERIFIED_BENEFICIARY, RISK_RULE.NEW_BENEFICIARY]
});

const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * Builds an effective config, layering optional environment overrides on top of
 * the defaults. Unknown keys are ignored so a typo cannot silently disable a rule.
 */
export const loadFraudConfig = (env = process.env) => {
    const thresholds = { ...DEFAULT_FRAUD_CONFIG.thresholds };
    const weights = { ...DEFAULT_FRAUD_CONFIG.weights };
    const windows = { ...DEFAULT_FRAUD_CONFIG.windows };

    const overrides = {
        velocityCount: ['FRAUD_VELOCITY_COUNT', thresholds, 'velocityCount'],
        highAmountMinor: ['FRAUD_HIGH_AMOUNT_MINOR', thresholds, 'highAmountMinor'],
        baselineMultiplier: ['FRAUD_BASELINE_MULTIPLIER', thresholds, 'baselineMultiplier'],
        beneficiaryBurstCount: ['FRAUD_BENEFICIARY_BURST_COUNT', thresholds, 'beneficiaryBurstCount'],
        failedAuthAttempts: ['FRAUD_FAILED_AUTH_ATTEMPTS', thresholds, 'failedAuthAttempts'],
        stepUpScore: ['FRAUD_STEP_UP_SCORE', thresholds, 'stepUpScore'],
        holdScore: ['FRAUD_HOLD_SCORE', thresholds, 'holdScore'],
        blockScore: ['FRAUD_BLOCK_SCORE', thresholds, 'blockScore']
    };

    for (const [key, [envKey, target]] of Object.entries(overrides)) {
        if (env[envKey] !== undefined && env[envKey] !== '') {
            target[key] = num(env[envKey], target[key]);
        }
    }

    if (env.FRAUD_VELOCITY_WINDOW_MINUTES) {
        windows.velocityMinutes = num(env.FRAUD_VELOCITY_WINDOW_MINUTES, windows.velocityMinutes);
    }
    if (env.FRAUD_BENEFICIARY_BURST_WINDOW_MINUTES) {
        windows.beneficiaryBurstMinutes = num(env.FRAUD_BENEFICIARY_BURST_WINDOW_MINUTES, windows.beneficiaryBurstMinutes);
    }

    return {
        version: DEFAULT_FRAUD_CONFIG.version,
        windows,
        thresholds,
        weights,
        hardBlockRules: [...DEFAULT_FRAUD_CONFIG.hardBlockRules],
        hardStepUpRules: [...DEFAULT_FRAUD_CONFIG.hardStepUpRules]
    };
};

export default DEFAULT_FRAUD_CONFIG;
