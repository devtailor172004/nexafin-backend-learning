import sequelize from '../../../../config/db.js';
import PineLabsOrder from '../../../../models/PineLabsOrder.js';
import PineLabsPayment from '../../../../models/PineLabsPayment.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { ApiResponse } from '../../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../../utils/httpStatus.js';
import logger from '../../../../utils/logger.js';
import { normalizePineLabsStatus } from '../../../../utils/pineLabsHelper.js';
import { mergeMaybeJson } from '../../../../utils/jsonColumn.js';
import {
    verifyPineLabsWebhookSignature,
    checkWebhookTimestamp
} from '../../../../Services/Pinelabs/webhookSignature.js';
import {
    claimWebhookEvent,
    resolveDuplicateWebhook,
    bumpWebhookAttempt,
    markWebhookProcessed,
    markWebhookFailed,
    sanitizeWebhookPayload
} from '../../../../securepay/webhookLedger.js';
import { recordPaymentEvent, applyInternalEvent } from '../../../../securepay/eventEngine.js';
import {
    mapProviderEventToInternal,
    statusForEvent,
    canTransition,
    PAYMENT_EVENT
} from '../../../../securepay/stateMachine.js';

const PROVIDER = 'PINELABS';

/**
 * Applies a verified provider webhook to local business state.
 *
 * Flow:
 *   sanitize -> find order -> per payment: set provider fields -> state machine
 *   -> timeline event -> mark ledger processed
 *
 * @returns {Promise<{orderId:number|null, paymentIds:number[], internalEvent:string}>}
 */
const applyWebhookToBusinessState = async ({ payload, webhookId, eventType, isMock = false }) => {
    const internalEvent = mapProviderEventToInternal(eventType);
    const targetPaymentStatus = statusForEvent(internalEvent);
    const providerOrderId = payload?.data?.order_id;

    if (!providerOrderId) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'NxPay webhook order_id is missing.');
    }

    const order = await PineLabsOrder.findOne({ where: { pluralOrderId: providerOrderId } });

    if (!order) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, `NxPay order not found for webhook order_id ${providerOrderId}.`);
    }

    const providerPayments = Array.isArray(payload?.data?.payments) ? payload.data.payments : [];
    const providerOrderStatus = normalizePineLabsStatus(payload?.data?.status || eventType);
    const paymentIds = [];
    let anyTransitionApplied = false;

    await sequelize.transaction(async (transaction) => {
        // ---- Order level -------------------------------------------------
        if (providerOrderStatus && canTransition(order.pluralStatus, providerOrderStatus)) {
            order.pluralStatus = providerOrderStatus;
            anyTransitionApplied = true;
        }
        order.rawOrderResponse = mergeMaybeJson(order.rawOrderResponse, {
            lastWebhookId: webhookId,
            lastWebhookEvent: eventType,
            lastWebhookReceivedAt: new Date().toISOString()
        });
        await order.save({ transaction });

        await recordPaymentEvent({
            orderId: order.id,
            eventType: 'WEBHOOK_RECEIVED',
            providerEventType: eventType,
            source: 'WEBHOOK',
            statusFrom: null,
            statusTo: order.pluralStatus,
            message: `${eventType} webhook received${isMock ? ' (mock)' : ''}`,
            providerEventId: webhookId,
            metadata: { internalEvent, isMock },
            transaction
        });

        // ---- Payment level -----------------------------------------------
        for (const providerPayment of providerPayments) {
            let payment = null;

            if (providerPayment.id) {
                payment = await PineLabsPayment.findOne({
                    where: { nxPayPaymentId: providerPayment.id, orderId: order.id },
                    transaction
                });
            }

            if (!payment && providerPayment.merchant_payment_reference) {
                payment = await PineLabsPayment.findOne({
                    where: { merchantPaymentReference: providerPayment.merchant_payment_reference, orderId: order.id },
                    transaction
                });
            }

            if (!payment) {
                payment = await PineLabsPayment.findOne({
                    where: { orderId: order.id, status: 'PENDING' },
                    order: [['createdAt', 'DESC']],
                    transaction
                });
            }

            if (!payment) {
                logger.warn(`No local payment matched for webhook ${webhookId} (order ${providerOrderId}).`);
                continue;
            }

            // Provider fields (does not change status yet).
            payment.nxPayOrderId = providerOrderId;
            if (providerPayment.id) payment.nxPayPaymentId = providerPayment.id;

            if (providerPayment.payment_amount?.value !== undefined) {
                payment.amount = Number(providerPayment.payment_amount.value) / 100;
            }
            if (providerPayment.payment_amount?.currency) {
                payment.currency = providerPayment.payment_amount.currency;
            }
            if (providerPayment.acquirer_data) {
                payment.acquirer = providerPayment.acquirer_data;
            }
            if (providerPayment.error_code) payment.errorCode = providerPayment.error_code;
            if (providerPayment.error_message) payment.errorMessage = providerPayment.error_message;

            await payment.save({ transaction });

            const result = await applyInternalEvent({
                payment,
                internalEvent,
                source: 'WEBHOOK',
                providerEventType: eventType,
                providerEventId: webhookId,
                message: providerPayment.error_message || `${eventType} applied from provider webhook`,
                metadata: { providerPaymentStatus: providerPayment.status || null, isMock },
                transaction
            });

            if (result.applied) anyTransitionApplied = true;
            paymentIds.push(payment.id);
        }

        // No payments in the payload: still move the order and log the event.
        if (!providerPayments.length) {
            await recordPaymentEvent({
                orderId: order.id,
                eventType: internalEvent,
                providerEventType: eventType,
                source: 'WEBHOOK',
                statusFrom: null,
                statusTo: targetPaymentStatus,
                message: `${eventType} applied at order level (no payments in payload)`,
                providerEventId: webhookId,
                transaction
            });
        }
    });

    return { orderId: order.id, paymentIds, internalEvent, anyTransitionApplied };
};

/**
 * Shared webhook processing pipeline.
 */
const processWebhook = async ({ req, eventType, payload, webhookId, webhookTimestamp, signatureVerified, isMock }) => {
    const providerOrderId = payload?.data?.order_id || null;
    const sanitizedPayload = sanitizeWebhookPayload(payload);
    const internalEvent = mapProviderEventToInternal(eventType);

    const { record, isDuplicate } = await claimWebhookEvent({
        provider: PROVIDER,
        webhookId,
        eventType,
        internalEvent,
        providerOrderId,
        webhookTimestamp,
        signatureVerified,
        isMock,
        sanitizedPayload
    });

    if (isDuplicate) {
        const decision = resolveDuplicateWebhook(record);
        logger.info(`Duplicate webhook ${webhookId} (${decision}).`);

        if (decision === 'IGNORE_DUPLICATE') {
            return {
                httpStatus: HTTP_STATUS.OK,
                body: { success: true, duplicate: true, message: `Webhook ${eventType} already processed.` }
            };
        }

        if (decision === 'IN_PROGRESS') {
            return {
                httpStatus: HTTP_STATUS.OK,
                body: { success: true, duplicate: true, message: `Webhook ${eventType} is already being processed.` }
            };
        }

        // Previous attempt failed -> retry with an incremented attempt count.
        await bumpWebhookAttempt(record);
    }

    try {
        const result = await applyWebhookToBusinessState({ payload, webhookId, eventType, isMock });

        await markWebhookProcessed(record, {
            localOrderId: result.orderId,
            localPaymentId: result.paymentIds[0] ?? null,
            internalEvent: result.internalEvent
        });

        logger.info(`Webhook ${eventType} processed successfully (${webhookId}).`);

        return {
            httpStatus: HTTP_STATUS.OK,
            body: {
                success: true,
                message: `${eventType} webhook processed successfully.`,
                internalEvent: result.internalEvent,
                matchedPayments: result.paymentIds.length
            }
        };
    } catch (error) {
        // Order not found is a data/timing issue: mark failed and let the
        // provider retry later. Everything else is a hard failure too.
        await markWebhookFailed(record, error);

        if (error instanceof ApiError) throw error;
        throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, `Webhook processing failed: ${error.message}`);
    }
};

/**
 * @desc    Handle real Pine Labs webhook events (signature ALWAYS verified)
 * @route   POST /api/payment/nxpay/webhook
 * @access  Public (signature protected)
 */
export const handlePineLabsWebhook = asyncHandler(async (req, res) => {
    const webhookId = req.headers['webhook-id'];
    const webhookTimestamp = req.headers['webhook-timestamp'];
    const webhookSignature = req.headers['webhook-signature'];

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Missing NxPay webhook signature headers.');
    }

    const rawBody = req.body;

    // 1. Timestamp freshness.
    const { fresh, webhookTime, ageSeconds } = checkWebhookTimestamp(webhookTimestamp);
    if (!fresh) {
        throw new ApiError(
            HTTP_STATUS.UNAUTHORIZED,
            `Expired or invalid NxPay webhook timestamp (age: ${ageSeconds ?? 'unknown'}s).`
        );
    }

    logger.info(`[Webhook] ${webhookId} | ts=${webhookTimestamp} | unix=${webhookTime}`);

    // 2. Signature (fail closed).
    const isValidSignature = verifyPineLabsWebhookSignature({
        webhookId,
        webhookTimestamp,
        webhookSignature,
        rawBody
    });

    if (!isValidSignature) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid NxPay webhook signature.');
    }

    // 3. Parse only after security checks.
    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid NxPay webhook JSON.');
    }

    const eventType = payload?.event_type;
    if (!eventType || !payload?.data) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid NxPay webhook payload.');
    }

    const { httpStatus, body } = await processWebhook({
        req,
        eventType,
        payload,
        webhookId,
        webhookTimestamp,
        signatureVerified: true,
        isMock: false
    });

    return res.status(httpStatus).json(body);
});

/**
 * @desc    Development/sandbox mock webhook — NO signature required.
 *          Disabled entirely when NODE_ENV=production so it can never be an
 *          environment-based security bypass on a live system.
 * @route   POST /api/payment/nxpay/mock/webhook
 * @access  Local development only
 */
export const handleMockPineLabsWebhook = asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Mock webhooks are disabled in production.');
    }

    const payload = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? req.body
        : (() => {
            try {
                return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
            } catch {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid mock webhook JSON.');
            }
        })();

    const eventType = payload?.event_type;
    if (!eventType || !payload?.data) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid mock webhook payload.');
    }

    // Deterministic id so re-sending the same mock event exercises dedupe.
    const webhookId = String(
        req.headers['webhook-id'] ||
        payload.event_id ||
        `mock_${eventType}_${payload.data.order_id || 'unknown'}_${payload.data.status || 'na'}`
    );

    const { httpStatus, body } = await processWebhook({
        req,
        eventType,
        payload,
        webhookId,
        webhookTimestamp: req.headers['webhook-timestamp'] || Math.floor(Date.now() / 1000),
        signatureVerified: false,
        isMock: true
    });

    return res.status(httpStatus).json(body);
});

export { applyWebhookToBusinessState };
