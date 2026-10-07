import ProviderWebhookEvent, { WEBHOOK_EVENT_STATUS } from '../models/ProviderWebhookEvent.js';
import logger from '../utils/logger.js';

/**
 * Webhook event ledger operations.
 *
 * Guarantees exactly-once application of provider webhooks via the
 * UNIQUE(provider, webhookId) constraint.
 */

const isUniqueViolation = (error) => (
    error?.name === 'SequelizeUniqueConstraintError' ||
    error?.original?.code === 'ER_DUP_ENTRY' ||
    /duplicate entry/i.test(error?.message || '')
);

/**
 * Keeps only the fields we actually operate on. Never persist the full raw
 * provider payload.
 */
export const sanitizeWebhookPayload = (payload = {}) => {
    const data = payload?.data || {};
    const payments = Array.isArray(data.payments) ? data.payments : [];
    const firstPayment = payments[0] || {};

    return {
        event_type: payload.event_type ?? null,
        order_id: data.order_id ?? null,
        status: data.status ?? null,
        order_amount: data.order_amount
            ? { value: data.order_amount.value ?? null, currency: data.order_amount.currency ?? null }
            : null,
        error_code: firstPayment.error_code ?? data.error_code ?? null,
        error_message: firstPayment.error_message ?? data.error_message ?? null,
        payment_count: payments.length,
        payments: payments.slice(0, 10).map((p) => ({
            id: p.id ?? null,
            merchant_payment_reference: p.merchant_payment_reference ?? null,
            status: p.status ?? null,
            payment_method: p.payment_method ?? null,
            payment_amount: p.payment_amount
                ? { value: p.payment_amount.value ?? null, currency: p.payment_amount.currency ?? null }
                : null,
            error_code: p.error_code ?? null,
            error_message: p.error_message ?? null
        }))
    };
};

/**
 * Claims a webhook event id for processing.
 *
 * @returns {Promise<{record, isNew, isDuplicate}>}
 *   isDuplicate = true when this webhook id was already seen.
 */
export const claimWebhookEvent = async ({
    provider = 'PINELABS',
    webhookId,
    eventType = null,
    internalEvent = null,
    providerOrderId = null,
    providerPaymentId = null,
    webhookTimestamp = null,
    signatureVerified = false,
    isMock = false,
    sanitizedPayload = null
}) => {
    try {
        const record = await ProviderWebhookEvent.create({
            provider,
            webhookId,
            eventType,
            internalEvent,
            providerOrderId,
            providerPaymentId,
            webhookTimestamp,
            signatureVerified,
            isMock,
            sanitizedPayload,
            status: WEBHOOK_EVENT_STATUS.PROCESSING,
            attempts: 1,
            receivedAt: new Date()
        });

        return { record, isNew: true, isDuplicate: false };
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;

        // Lost the race / already seen: load the existing ledger row.
        const existing = await ProviderWebhookEvent.findOne({
            where: { provider, webhookId }
        });

        if (!existing) {
            // Extremely unlikely: row vanished between insert and read.
            throw error;
        }

        return { record: existing, isNew: false, isDuplicate: true };
    }
};

/**
 * Decides what to do with an already-seen webhook.
 *
 * @returns {'IGNORE_DUPLICATE'|'IN_PROGRESS'|'RETRY'}
 */
export const resolveDuplicateWebhook = (existing) => {
    if (!existing) return 'RETRY';

    switch (existing.status) {
        case WEBHOOK_EVENT_STATUS.PROCESSED:
        case WEBHOOK_EVENT_STATUS.IGNORED:
            return 'IGNORE_DUPLICATE';
        case WEBHOOK_EVENT_STATUS.PROCESSING:
            return 'IN_PROGRESS';
        case WEBHOOK_EVENT_STATUS.FAILED:
        case WEBHOOK_EVENT_STATUS.RECEIVED:
        default:
            return 'RETRY';
    }
};

export const bumpWebhookAttempt = async (record) => {
    record.attempts = (record.attempts || 0) + 1;
    record.status = WEBHOOK_EVENT_STATUS.PROCESSING;
    await record.save();
    return record;
};

export const markWebhookProcessed = async (record, { localOrderId = null, localPaymentId = null, internalEvent = null } = {}) => {
    record.status = WEBHOOK_EVENT_STATUS.PROCESSED;
    record.processedAt = new Date();
    if (localOrderId) record.localOrderId = localOrderId;
    if (localPaymentId) record.localPaymentId = localPaymentId;
    if (internalEvent) record.internalEvent = internalEvent;
    await record.save();
    return record;
};

export const markWebhookIgnored = async (record, { internalEvent = null, message = null } = {}) => {
    record.status = WEBHOOK_EVENT_STATUS.IGNORED;
    record.processedAt = new Date();
    if (internalEvent) record.internalEvent = internalEvent;
    if (message) record.errorMessage = message;
    await record.save();
    return record;
};

export const markWebhookFailed = async (record, error) => {
    record.status = WEBHOOK_EVENT_STATUS.FAILED;
    record.errorMessage = String(error?.message || error).slice(0, 5000);
    await record.save();
    logger.error(`Webhook ledger marked FAILED for ${record.provider}:${record.webhookId}: ${record.errorMessage}`);
    return record;
};
