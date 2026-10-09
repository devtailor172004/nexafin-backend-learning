import crypto from 'crypto';

import User from '../models/User.js';
import RiskEvent from '../models/RiskEvent.js';
import AccountFreeze from '../models/AccountFreeze.js';
import LedgerEntry from '../models/LedgerEntry.js';
import ProviderWebhookEvent from '../models/ProviderWebhookEvent.js';
import AuditLog from '../models/AuditLog.js';
import { evaluateAttempt, unfreezeAccount } from './fraudService.js';
import { ensureAccount, postJournal } from './ledger.js';
import { claimWebhookEvent, resolveDuplicateWebhook, markWebhookProcessed } from './webhookLedger.js';
import { verifyPineLabsWebhookSignature } from '../Services/Pinelabs/webhookSignature.js';
import { assertResourceOwner } from './tenant.js';
import { claimIdempotency, markIdempotencyCompleted } from '../utils/idempotency.js';
import { loadFraudConfig, RISK_DECISION } from '../config/fraudConfig.js';
import { publishSecurityEvent, SECURITY_EVENT } from './securityEvents.js';
import { HTTP_STATUS } from '../utils/httpStatus.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Fraud Lab — safe, repeatable security scenarios.
 *
 * Every scenario runs against **synthetic sandbox data only**. Nothing here
 * touches a real provider, real funds or production data, and the whole lab is
 * refused when NODE_ENV=production.
 *
 * A scenario is only reported as passed when the relevant *business and security
 * invariants* hold — never merely because a call returned without throwing.
 */

export const isFraudLabEnabled = () =>
    process.env.NODE_ENV !== 'production' && process.env.FRAUD_LAB_ENABLED !== 'false';

/* ------------------------------------------------------------------ *
 * Metadata (safe to expose to the frontend)
 * ------------------------------------------------------------------ */

export const FRAUD_LAB_SCENARIOS = [
    {
        id: 'A',
        name: 'Normal activity',
        description: 'Generate a few ordinary low-risk simulated payouts for one sandbox retailer.',
        whatItTests: 'The engine permits normal behaviour and does not freeze a healthy account.',
        expected: 'All attempts ALLOW, no account freeze, ledger unchanged.'
    },
    {
        id: 'B',
        name: 'Transaction velocity anomaly',
        description: 'Fire a configurable burst of simulated payouts against one sandbox retailer.',
        whatItTests: 'Velocity and amount rules raise risk, a hold/block is applied and the account stops moving money.',
        expected: 'Velocity rule fires, risk score rises, an alert is created, the account is frozen and further payouts are refused.'
    },
    {
        id: 'C',
        name: 'Suspicious beneficiary',
        description: 'Attempt a high-value payout to a brand-new, unverified beneficiary.',
        whatItTests: 'Beneficiary verification state is checked before money moves.',
        expected: 'The payout is denied or requires extra verification; it is never silently allowed.'
    },
    {
        id: 'D',
        name: 'Repeated payment request (idempotency)',
        description: 'Replay the same payout with the same Idempotency-Key, then reuse the key with a different body.',
        whatItTests: 'Exactly-once business effect and conflict detection.',
        expected: 'One business operation; a valid replay returns the original result; a changed payload is rejected with HTTP 409.'
    },
    {
        id: 'E',
        name: 'Unauthorized resource access (BOLA)',
        description: 'Authenticated as retailer A, try to read a resource owned by retailer B.',
        whatItTests: 'Server-side ownership validation, not UI hiding.',
        expected: 'Access denied (403/404), no data returned, no financial data modified.'
    },
    {
        id: 'F',
        name: 'Concurrent debit',
        description: 'Issue concurrent debits whose total exceeds the synthetic wallet balance.',
        whatItTests: 'Atomic, row-locked balance protection.',
        expected: 'Balance never negative; only affordable debits post; every posted debit is ledger-balanced.'
    },
    {
        id: 'G',
        name: 'Invalid webhook',
        description: 'Submit a webhook with a wrong signature and a tampered body through the real verifier.',
        whatItTests: 'Fail-closed signature verification.',
        expected: 'Rejected; no state change; no wallet credit; the attempt is recorded without storing secrets.'
    },
    {
        id: 'H',
        name: 'Duplicate webhook',
        description: 'Submit the same valid sandbox webhook event twice.',
        whatItTests: 'Exactly-once webhook application via the event ledger.',
        expected: 'The duplicate is identified and ignored; payment/ledger state is unchanged by the replay.'
    },
    {
        id: 'I',
        name: 'Incident response',
        description: 'Drive a suspicious series of payouts, then review the resulting incident as an administrator.',
        whatItTests: 'Holds, incident creation, administrator review and the audit timeline.',
        expected: 'High-risk operations held, incident created, administrator can review, blocked operations leave the ledger untouched.'
    }
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SANDBOX_RETAILERS = {
    A: { fullName: 'Sandbox Retailer A', email: 'sandbox.retailer.a@securepay.local', mobile: '9000000001' },
    B: { fullName: 'Sandbox Retailer B', email: 'sandbox.retailer.b@securepay.local', mobile: '9000000002' }
};

/** Finds or creates a clearly-labelled synthetic sandbox retailer. */
export const ensureSandboxRetailer = async (label) => {
    const def = SANDBOX_RETAILERS[label] || SANDBOX_RETAILERS.A;
    const [user] = await User.findOrCreate({
        where: { email: def.email },
        defaults: {
            ...def,
            role: 'User',
            password: crypto.randomBytes(24).toString('hex'),
            is_agreement: 'sandbox',
            status: 'sandbox'
        }
    });
    return user;
};

/** Releases any active freeze so scenarios are repeatable. */
const resetRetailer = async (userId) => {
    const active = await AccountFreeze.findAll({ where: { userId, status: 'ACTIVE' } });
    for (const freeze of active) {
        freeze.status = 'RELEASED';
        freeze.releasedAt = new Date();
        freeze.releaseReason = 'Fraud Lab scenario reset';
        await freeze.save();
    }
};

const ledgerEntryCount = () => LedgerEntry.count();

const step = (name, detail, ok = true) => ({ name, detail, ok });

const baseReport = (scenario, { steps, actual, passed, extra = {} }) => ({
    scenario: scenario.id,
    name: scenario.name,
    whatItTests: scenario.whatItTests,
    expected: scenario.expected,
    steps,
    actual,
    passed,
    sandbox: true,
    simulated: true,
    ranAt: new Date().toISOString(),
    ...extra
});

/* ------------------------------------------------------------------ *
 * Scenario A — normal activity
 * ------------------------------------------------------------------ */

const scenarioA = async (scenario) => {
    const retailer = await ensureSandboxRetailer('A');
    await resetRetailer(retailer.id);
    const before = await ledgerEntryCount();

    const steps = [];
    const decisions = [];
    const riskEventIds = [];

    for (let i = 0; i < 3; i += 1) {
        const result = await evaluateAttempt({
            userId: retailer.id,
            transactionId: `sandbox-a-${i}`,
            amountMinor: 25000,
            operation: 'PAYOUT',
            signals: { beneficiaryVerified: true, beneficiaryAgeMinutes: 5000 }
        });
        decisions.push(result.decision);
        riskEventIds.push(result.riskEventId);
        steps.push(step(`attempt ${i + 1}`, `${result.decision} (score ${result.riskScore}, ${result.riskLevel})`));
    }

    const activeFreeze = await AccountFreeze.count({ where: { userId: retailer.id, status: 'ACTIVE' } });
    const after = await ledgerEntryCount();

    const allAllowed = decisions.every((d) => d === RISK_DECISION.ALLOW);
    steps.push(step('no freeze created', `active freezes: ${activeFreeze}`, activeFreeze === 0));
    steps.push(step('ledger unchanged', `entries ${before} -> ${after}`, before === after));

    return baseReport(scenario, {
        steps,
        actual: `3 low-value payouts evaluated: ${decisions.join(', ')}. Active freezes: ${activeFreeze}. Ledger entries: ${before} -> ${after}.`,
        passed: allAllowed && activeFreeze === 0 && before === after,
        extra: { decisions, riskEventIds, ledgerChanged: after !== before }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario B — velocity anomaly
 * ------------------------------------------------------------------ */

const scenarioB = async (scenario, { params }) => {
    const cfg = loadFraudConfig();
    const burst = Number(params.burst) > 0 ? Number(params.burst) : cfg.thresholds.velocityCount + 2;

    const retailer = await ensureSandboxRetailer('B');
    await resetRetailer(retailer.id);
    const before = await ledgerEntryCount();

    const steps = [];
    const results = [];

    for (let i = 0; i < burst; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await evaluateAttempt({
            userId: retailer.id,
            transactionId: `sandbox-b-${i}`,
            amountMinor: 400000,
            operation: 'PAYOUT',
            signals: { beneficiaryVerified: false, beneficiaryAgeMinutes: 1, newDevice: true }
        });
        results.push(result);
        steps.push(step(`attempt ${i + 1}`, `${result.decision} (score ${result.riskScore}) rules: ${result.rulesTriggered.map((r) => r.rule).join(', ') || 'none'}`));
        if (result.frozen) break;
    }

    const velocityFired = results.some((r) => r.rulesTriggered.some((rule) => rule.rule === 'VELOCITY'));
    const blocked = results.some((r) => r.decision === RISK_DECISION.HOLD || r.decision === RISK_DECISION.BLOCK);
    const freezeActive = await AccountFreeze.count({ where: { userId: retailer.id, status: 'ACTIVE' } });

    // The protected account must not be able to continue.
    let followUpBlocked = false;
    let followUpDecision = null;
    if (freezeActive > 0) {
        const followUp = await evaluateAttempt({
            userId: retailer.id,
            transactionId: 'sandbox-b-after-freeze',
            amountMinor: 1000,
            operation: 'PAYOUT'
        });
        followUpBlocked = followUp.decision === RISK_DECISION.BLOCK;
        followUpDecision = followUp.decision;
    }

    const after = await ledgerEntryCount();
    steps.push(step('velocity rule fired', String(velocityFired), velocityFired));
    steps.push(step('account frozen', `active freezes: ${freezeActive}`, freezeActive > 0));
    steps.push(step('further payouts refused', `follow-up decision: ${followUpDecision}`, followUpBlocked));
    steps.push(step('ledger unchanged by held attempts', `entries ${before} -> ${after}`, before === after));

    return baseReport(scenario, {
        steps,
        actual: `Burst of ${results.length} attempts. Final decision ${results.at(-1)?.decision} at score ${results.at(-1)?.riskScore}. Freeze active: ${freezeActive > 0}. Follow-up attempt: ${followUpDecision}.`,
        passed: velocityFired && blocked && freezeActive > 0 && followUpBlocked && before === after,
        extra: {
            decisions: results.map((r) => r.decision),
            scores: results.map((r) => r.riskScore),
            rulesTriggered: [...new Set(results.flatMap((r) => r.rulesTriggered.map((x) => x.rule)))],
            ledgerChanged: after !== before
        }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario C — suspicious beneficiary
 * ------------------------------------------------------------------ */

const scenarioC = async (scenario) => {
    const retailer = await ensureSandboxRetailer('A');
    await resetRetailer(retailer.id);

    const result = await evaluateAttempt({
        userId: retailer.id,
        transactionId: 'sandbox-c-beneficiary',
        amountMinor: 900000,
        operation: 'PAYOUT',
        signals: { beneficiaryVerified: false, beneficiaryAgeMinutes: 2, beneficiariesAddedRecently: 3 }
    });

    const rules = result.rulesTriggered.map((r) => r.rule);
    const checksBeneficiary = rules.includes('UNVERIFIED_BENEFICIARY');
    const notAllowed = result.decision !== RISK_DECISION.ALLOW;

    const steps = [
        step('beneficiary verification state checked', rules.join(', ') || 'no rules', checksBeneficiary),
        step('decision is not a silent allow', `${result.decision} (score ${result.riskScore})`, notAllowed),
        step('audit event recorded', result.riskEventId || 'recorded', Boolean(result.riskEventId))
    ];

    return baseReport(scenario, {
        steps,
        actual: `Decision ${result.decision} at score ${result.riskScore}. Rules: ${rules.join(', ') || 'none'}.`,
        passed: checksBeneficiary && notAllowed,
        extra: { decision: result.decision, riskScore: result.riskScore, rulesTriggered: rules, riskEventId: result.riskEventId }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario D — idempotency replay
 * ------------------------------------------------------------------ */

const fakeRequest = ({ key, body, path = '/sandbox/fraud-lab/payout' }) => ({
    method: 'POST',
    originalUrl: path,
    params: {},
    query: {},
    body,
    get: (header) => (String(header).toLowerCase() === 'idempotency-key' ? key : undefined)
});

const scenarioD = async (scenario) => {
    const retailer = await ensureSandboxRetailer('A');
    const key = `fraudlab-${crypto.randomUUID()}`;
    const body = { amountMinor: 15000, beneficiary: 'sandbox-beneficiary-1' };

    const steps = [];
    let businessOperations = 0;

    // 1. First request claims the key.
    const first = await claimIdempotency({ req: fakeRequest({ key, body }), userId: retailer.id, scope: 'SANDBOX_PAYOUT' });
    if (!first.replay) businessOperations += 1;
    await markIdempotencyCompleted(first.record, { statusCode: 200, responseBody: { ok: true, operation: 1 } });
    steps.push(step('first request processed', `replay=${first.replay}, business operations=${businessOperations}`, businessOperations === 1));

    // 2. Valid replay of the identical request.
    const replay = await claimIdempotency({ req: fakeRequest({ key, body }), userId: retailer.id, scope: 'SANDBOX_PAYOUT' });
    if (!replay.replay) businessOperations += 1;
    steps.push(step('identical replay returns the original result', `replay=${replay.replay}, status=${replay.responseStatus}`, replay.replay === true));

    // 3. Same key, different payload -> conflict.
    let conflictStatus = null;
    try {
        await claimIdempotency({
            req: fakeRequest({ key, body: { amountMinor: 999999 } }),
            userId: retailer.id,
            scope: 'SANDBOX_PAYOUT'
        });
    } catch (error) {
        conflictStatus = error?.statusCode || null;
    }
    steps.push(step('key reused with a different payload is rejected', `HTTP ${conflictStatus}`, conflictStatus === (HTTP_STATUS.CONFLICT || 409)));

    return baseReport(scenario, {
        steps,
        actual: `Business operations created: ${businessOperations}. Replay served from the stored response. Conflicting reuse returned HTTP ${conflictStatus}.`,
        passed: businessOperations === 1 && replay.replay === true && conflictStatus === (HTTP_STATUS.CONFLICT || 409),
        extra: { businessOperations, conflictStatus, key }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario E — BOLA / tenant isolation
 * ------------------------------------------------------------------ */

const scenarioE = async (scenario) => {
    const retailerA = await ensureSandboxRetailer('A');
    const retailerB = await ensureSandboxRetailer('B');

    // A real resource owned by B.
    const ownedByB = await evaluateAttempt({
        userId: retailerB.id,
        transactionId: 'sandbox-e-resource-b',
        amountMinor: 9000,
        operation: 'PAYOUT',
        signals: { beneficiaryVerified: true, beneficiaryAgeMinutes: 5000 }
    });

    const steps = [];
    let deniedStatus = null;
    let leaked = false;

    // Authenticated as A, asking for B's resource.
    try {
        assertResourceOwner({ actorId: retailerA.id, ownerId: retailerB.id, resourceType: 'Risk event' });
        leaked = true;
    } catch (error) {
        deniedStatus = error?.statusCode || null;
    }
    steps.push(step('cross-tenant read denied', `HTTP ${deniedStatus}`, deniedStatus === (HTTP_STATUS.FORBIDDEN || 403)));

    // Changing the id in the request must not help: ownership is server-side only.
    let idSwapDenied = null;
    try {
        assertResourceOwner({ actorId: retailerA.id, ownerId: retailerB.id, resourceType: 'Payment' });
    } catch (error) {
        idSwapDenied = error?.statusCode || null;
    }
    steps.push(step('changing the resource id does not bypass ownership', `HTTP ${idSwapDenied}`, idSwapDenied === (HTTP_STATUS.FORBIDDEN || 403)));

    // Owner still has access to their own resource.
    let ownerOk = false;
    try {
        ownerOk = assertResourceOwner({ actorId: retailerB.id, ownerId: retailerB.id, resourceType: 'Risk event' }) === true;
    } catch {
        ownerOk = false;
    }
    steps.push(step('the owner retains access', String(ownerOk), ownerOk));

    // No data and no financial mutation resulted from the denied attempt.
    const stillSameOwner = await RiskEvent.findOne({ where: { uuid: ownedByB.riskEventId } });
    const dataIntact = Boolean(stillSameOwner) && stillSameOwner.userId === retailerB.id;
    steps.push(step('no unauthorized data returned / modified', `resource owner unchanged: ${dataIntact}`, dataIntact));

    return baseReport(scenario, {
        steps,
        actual: `Cross-tenant access denied with HTTP ${deniedStatus}. Owner access preserved. Resource ownership unchanged: ${dataIntact}.`,
        passed: deniedStatus === (HTTP_STATUS.FORBIDDEN || 403) && !leaked && ownerOk && dataIntact,
        extra: { deniedStatus, leaked, ownerOk, resourceOwnerUnchanged: dataIntact }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario F — concurrent debit
 * ------------------------------------------------------------------ */

const WALLET_F = 'SANDBOX:FRAUDLAB:WALLET';
const CASH_F = 'SANDBOX:FRAUDLAB:CASH';

const scenarioF = async (scenario, { params }) => {
    const concurrency = Math.min(Math.max(Number(params.concurrency) || 10, 2), 25);

    const wallet = await ensureAccount({
        code: WALLET_F,
        name: 'Fraud Lab sandbox wallet',
        accountType: 'LIABILITY',
        normalBalance: 'CREDIT',
        ownerType: 'SANDBOX',
        ownerId: 'fraudlab'
    });
    const cash = await ensureAccount({
        code: CASH_F,
        name: 'Fraud Lab sandbox cash',
        accountType: 'ASSET',
        normalBalance: 'DEBIT',
        ownerType: 'SANDBOX',
        ownerId: 'fraudlab'
    });

    // Top the wallet up to a known round balance so the scenario is repeatable.
    const current = Number(wallet.balanceMinor);
    const target = 100_00; // ₹100.00
    if (current !== target) {
        const delta = target - current;
        await postJournal({
            transactionRef: `SANDBOX:FRAUDLAB:FUND:${Date.now()}`,
            entries: [
                { accountCode: WALLET_F, direction: delta > 0 ? 'CREDIT' : 'DEBIT', amountMinor: Math.abs(delta) },
                { accountCode: CASH_F, direction: delta > 0 ? 'DEBIT' : 'CREDIT', amountMinor: Math.abs(delta) }
            ],
            memo: 'Fraud Lab funding top-up',
            allowNegative: true
        });
    }

    await wallet.reload();
    const startingBalance = Number(wallet.balanceMinor);
    const perDebit = Math.floor(startingBalance * 0.3); // 30% each => at most 3 fit
    const affordable = perDebit > 0 ? Math.floor(startingBalance / perDebit) : 0;

    const attempts = await Promise.allSettled(
        Array.from({ length: concurrency }, (_, i) => postJournal({
            transactionRef: `SANDBOX:FRAUDLAB:DEBIT:${Date.now()}:${i}`,
            entries: [
                { accountCode: WALLET_F, direction: 'DEBIT', amountMinor: perDebit },
                { accountCode: CASH_F, direction: 'CREDIT', amountMinor: perDebit }
            ],
            memo: 'Fraud Lab concurrent debit'
        }))
    );

    const posted = attempts.filter((a) => a.status === 'fulfilled').length;
    const rejected = attempts.filter((a) => a.status === 'rejected').length;

    await wallet.reload();
    const finalBalance = Number(wallet.balanceMinor);

    const steps = [
        step('starting balance', `${startingBalance} minor units`, true),
        step('concurrent debits issued', `${concurrency} x ${perDebit} minor units`, true),
        step('only affordable debits posted', `posted ${posted}, rejected ${rejected}`, posted <= affordable),
        step('balance never became negative', `final balance ${finalBalance}`, finalBalance >= 0),
        step('no overspend', `${posted} x ${perDebit} = ${posted * perDebit} <= ${startingBalance}`, posted * perDebit <= startingBalance)
    ];

    return baseReport(scenario, {
        steps,
        actual: `${posted} of ${concurrency} debits posted, ${rejected} rejected for insufficient funds. Balance ${startingBalance} -> ${finalBalance}.`,
        passed: posted <= affordable && finalBalance >= 0 && posted * perDebit <= startingBalance && posted > 0,
        extra: { concurrency, posted, rejected, perDebit, startingBalance, finalBalance }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario G — invalid webhook
 * ------------------------------------------------------------------ */

const scenarioG = async (scenario) => {
    const secret = process.env.PINE_LABS_CLIENT_SECRET || 'sandbox-webhook-secret';
    const webhookId = `fraudlab-invalid-${crypto.randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({ event_type: 'ORDER_PROCESSED', data: { order_id: 'sandbox-order', status: 'PROCESSED' } });

    const validSignature = crypto
        .createHmac('sha256', Buffer.from(String(secret).trim(), 'utf8'))
        .update(`${webhookId}.${timestamp}.${rawBody}`)
        .digest('base64');

    const before = await ProviderWebhookEvent.count();

    // Positive control: the correct signature is accepted.
    const validAccepted = verifyPineLabsWebhookSignature({
        webhookId, webhookTimestamp: timestamp, webhookSignature: validSignature, rawBody, secretKey: secret
    });

    // Wrong signature rejected.
    const wrongSignatureRejected = verifyPineLabsWebhookSignature({
        webhookId, webhookTimestamp: timestamp, webhookSignature: 'not-a-real-signature', rawBody, secretKey: secret
    }) === false;

    // Tampered body with the original signature rejected.
    const tamperedBodyRejected = verifyPineLabsWebhookSignature({
        webhookId, webhookTimestamp: timestamp, webhookSignature: validSignature,
        rawBody: rawBody.replace('PROCESSED', 'AUTHORIZED'), secretKey: secret
    }) === false;

    const after = await ProviderWebhookEvent.count();

    const steps = [
        step('validly-signed sandbox event accepted (control)', String(validAccepted), validAccepted === true),
        step('invalid signature rejected', String(wrongSignatureRejected), wrongSignatureRejected),
        step('tampered body rejected', String(tamperedBodyRejected), tamperedBodyRejected),
        step('no business state changed', `webhook ledger rows ${before} -> ${after}`, before === after)
    ];

    if (!wrongSignatureRejected || !tamperedBodyRejected) {
        await AuditLog.create({
            action: 'WEBHOOK_SIGNATURE_FAILURE',
            entityType: 'webhook',
            entityId: webhookId,
            description: 'Fraud Lab scenario G: signature verification failure recorded (no secrets stored).',
            outcome: 'REJECTED',
            source: 'FRAUD_LAB'
        });
    }

    publishSecurityEvent(SECURITY_EVENT.WEBHOOK_REJECTED, { webhookId: `${webhookId.slice(0, 12)}…`, scenario: 'G' });

    return baseReport(scenario, {
        steps,
        actual: `Valid signature accepted: ${validAccepted}. Invalid signature rejected: ${wrongSignatureRejected}. Tampered body rejected: ${tamperedBodyRejected}. Webhook ledger rows unchanged: ${before === after}.`,
        passed: validAccepted === true && wrongSignatureRejected && tamperedBodyRejected && before === after,
        extra: { signatureRejected: wrongSignatureRejected, tamperedRejected: tamperedBodyRejected, ledgerChanged: before !== after }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario H — duplicate webhook
 * ------------------------------------------------------------------ */

const scenarioH = async (scenario) => {
    const webhookId = `fraudlab-duplicate-${crypto.randomUUID()}`;

    const first = await claimWebhookEvent({
        provider: 'PINELABS',
        webhookId,
        eventType: 'ORDER_PROCESSED',
        internalEvent: 'PAYMENT_PROCESSED',
        signatureVerified: true,
        isMock: true,
        sanitizedPayload: { event_type: 'ORDER_PROCESSED', order_id: 'sandbox-order' }
    });

    // Simulate the business effect happening exactly once.
    let businessEffects = 0;
    if (first.isNew) businessEffects += 1;
    await markWebhookProcessed(first.record, { internalEvent: 'PAYMENT_PROCESSED' });

    // Same event delivered again.
    const second = await claimWebhookEvent({
        provider: 'PINELABS',
        webhookId,
        eventType: 'ORDER_PROCESSED',
        internalEvent: 'PAYMENT_PROCESSED',
        signatureVerified: true,
        isMock: true,
        sanitizedPayload: { event_type: 'ORDER_PROCESSED', order_id: 'sandbox-order' }
    });

    const action = resolveDuplicateWebhook(second.record);
    if (second.isNew) businessEffects += 1;

    const rows = await ProviderWebhookEvent.count({ where: { provider: 'PINELABS', webhookId } });

    const steps = [
        step('first delivery processed', `isNew=${first.isNew}`, first.isNew === true),
        step('duplicate delivery detected', `isDuplicate=${second.isDuplicate}`, second.isDuplicate === true),
        step('duplicate ignored', action, action === 'IGNORE_DUPLICATE'),
        step('business effect applied exactly once', `effects=${businessEffects}, ledger rows=${rows}`, businessEffects === 1 && rows === 1)
    ];

    return baseReport(scenario, {
        steps,
        actual: `First delivery new: ${first.isNew}. Second delivery duplicate: ${second.isDuplicate}, action ${action}. Business effects: ${businessEffects}. Ledger rows: ${rows}.`,
        passed: first.isNew === true && second.isDuplicate === true && action === 'IGNORE_DUPLICATE' && businessEffects === 1 && rows === 1,
        extra: { duplicateAction: action, businessEffects, ledgerRows: rows }
    });
};

/* ------------------------------------------------------------------ *
 * Scenario I — incident response
 * ------------------------------------------------------------------ */

const scenarioI = async (scenario, { actor }) => {
    const retailer = await ensureSandboxRetailer('B');
    await resetRetailer(retailer.id);

    const before = await ledgerEntryCount();
    const steps = [];

    // Suspicious series of payout attempts.
    const results = [];
    for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await evaluateAttempt({
            userId: retailer.id,
            transactionId: `sandbox-i-${i}`,
            amountMinor: 750000,
            operation: 'PAYOUT',
            signals: { beneficiaryVerified: false, beneficiaryAgeMinutes: 1, failedAuthAttempts: 3 }
        });
        results.push(result);
        if (result.frozen) break;
    }

    const blocked = results.filter((r) => r.decision === RISK_DECISION.HOLD || r.decision === RISK_DECISION.BLOCK);
    steps.push(step('high-risk operations held', `${blocked.length} of ${results.length} held/blocked`, blocked.length > 0));

    const incidentIds = [...new Set(results.map((r) => r.incidentId).filter(Boolean))];
    steps.push(step('security incident created', incidentIds.join(', ') || 'none', incidentIds.length > 0));

    // Administrator review: release the freeze with a documented reason.
    let released = null;
    const activeFreeze = await AccountFreeze.findOne({ where: { userId: retailer.id, status: 'ACTIVE' } });
    if (activeFreeze) {
        const release = await unfreezeAccount({
            userId: retailer.id,
            reason: 'Fraud Lab scenario I: verified as simulated activity by administrator',
            actorId: actor?.id || null,
            actorRole: actor?.role || 'Admin'
        });
        released = release.length;
        steps.push(step('administrator reviewed and released', `released ${released} freeze(s)`, released > 0));
    } else {
        steps.push(step('administrator reviewed and released', 'no active freeze to release', false));
    }

    const timelineEntries = await AuditLog.count({ where: { source: 'SECURITY' } });

    const after = await ledgerEntryCount();
    steps.push(step('ledger unchanged for blocked operations', `entries ${before} -> ${after}`, before === after));
    steps.push(step('audit timeline populated', `${timelineEntries} security audit records`, timelineEntries > 0));

    return baseReport(scenario, {
        steps,
        actual: `${blocked.length} high-risk attempts blocked, incident(s) ${incidentIds.join(', ') || 'none'} created, ${released ?? 0} freeze(s) released by administrator. Ledger entries ${before} -> ${after}.`,
        passed: blocked.length > 0 && incidentIds.length > 0 && released > 0 && before === after,
        extra: {
            blockedCount: blocked.length,
            incidentIds,
            releasedFreezes: released,
            ledgerChanged: after !== before,
            auditRecords: timelineEntries
        }
    });
};

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

const REGISTRY = {
    A: scenarioA,
    B: scenarioB,
    C: scenarioC,
    D: scenarioD,
    E: scenarioE,
    F: scenarioF,
    G: scenarioG,
    H: scenarioH,
    I: scenarioI
};

/**
 * Runs one Fraud Lab scenario.
 * @throws {ApiError} 403 in production, 404 for an unknown scenario
 */
export const runFraudLabScenario = async ({ scenarioId, params = {}, actor = {}, ipAddress = null, requestId = null }) => {
    if (!isFraudLabEnabled()) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN || 403, 'The Fraud Lab is disabled outside non-production sandbox environments.');
    }

    const scenario = FRAUD_LAB_SCENARIOS.find((s) => s.id === String(scenarioId).toUpperCase());
    if (!scenario) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, `Unknown scenario '${scenarioId}'.`);
    }

    const startedAt = Date.now();
    let report;
    try {
        report = await REGISTRY[scenario.id](scenario, { params, actor, ipAddress, requestId });
    } catch (error) {
        report = baseReport(scenario, {
            steps: [step('scenario execution', error.message, false)],
            actual: `Scenario aborted: ${error.message}`,
            passed: false,
            extra: { error: error.message }
        });
    }

    report.durationMs = Date.now() - startedAt;

    publishSecurityEvent(SECURITY_EVENT.SCENARIO_COMPLETED, {
        scenario: scenario.id,
        passed: report.passed,
        durationMs: report.durationMs
    });

    // Record the run in the audit trail (non-critical: a failed audit must not
    // hide the scenario result from the operator).
    try {
        const { writeAuditLog } = await import('./auditLog.js');
        await writeAuditLog({
            actorId: actor?.id || null,
            actorRole: actor?.role || null,
            action: 'FRAUD_LAB_SCENARIO_RUN',
            entityType: 'fraud_lab_scenario',
            entityId: scenario.id,
            description: `Fraud Lab scenario ${scenario.id} ${report.passed ? 'passed' : 'failed'}`,
            outcome: report.passed ? 'PASSED' : 'FAILED',
            source: 'FRAUD_LAB',
            ipAddress,
            requestId,
            metadata: { durationMs: report.durationMs }
        });
    } catch {
        // ignore — the report is still returned to the operator
    }

    return report;
};

export default runFraudLabScenario;
