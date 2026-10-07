import crypto from 'crypto';
import sequelize from '../../../../config/db.js';
import PineLabsOrder from '../../../../models/PineLabsOrder.js';
import PineLabsPayment from '../../../../models/PineLabsPayment.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { HTTP_STATUS } from '../../../../utils/httpStatus.js';
import logger from '../../../../utils/logger.js';

/**
 * Verify Pine Labs webhook signature.
 *
 * Signed content:
 * webhook-id.webhook-timestamp.raw-body
 *
 * Secret key is Base64 encoded.
 */
const verifyPineLabsWebhookSignature = ({
    webhookId,
    webhookTimestamp,
    webhookSignature,
    rawBody
}) => {
    const secretKey = process.env.PINE_LABS_CLIENT_SECRET;
    const isTestMode = process.env.NODE_ENV !== 'production';

    // Local UAT/development testing bypass in non-production
    if (
        isTestMode &&
        (!secretKey ||
            secretKey === 'YOUR_CLIENT_SECRET' ||
            String(secretKey).trim() === '')
    ) {
        return true;
    }

    if (!secretKey || String(secretKey).trim() === '') {
        throw new Error(
            'PINE_LABS_CLIENT_SECRET is not configured.'
        );
    }

    if (!webhookId || !webhookTimestamp || !webhookSignature || !rawBody) {
        logger.warn('[PineLabs Webhook Debug] Missing required signature verification components');
        return false;
    }

    const body = (Buffer.isBuffer(rawBody)
        ? rawBody.toString('utf8')
        : String(rawBody)).trimEnd(); // strip trailing \r\n added by curl/clients

    const signedContent =
        `${webhookId}.${webhookTimestamp}.${body}`;

    let receivedSig = String(webhookSignature || '')
        .trim()
        .replace(/^"|"$/g, '');

    // Strip "v1," or any "v<N>," prefix from the signature
    receivedSig = receivedSig.replace(/^v\d+,/, '');

    // Attempt to verify with different possible representations of the secret key
    const possibleSecrets = [];

    // 1. Plain UTF-8 string bytes
    possibleSecrets.push(Buffer.from(secretKey.trim(), 'utf8'));

    // 2. Base64 decoded bytes (fallback/legacy)
    try {
        possibleSecrets.push(Buffer.from(secretKey.trim(), 'base64'));
    } catch (e) {
        // ignore
    }

    // 3. Hex decoded bytes (as client secret is in hex)
    try {
        if (/^[0-9a-fA-F]+$/.test(secretKey.trim())) {
            possibleSecrets.push(Buffer.from(secretKey.trim(), 'hex'));
        }
    } catch (e) {
        // ignore
    }

    logger.info(`[PineLabs Webhook Debug] Body Length: ${body.length}`);
    logger.info(`[PineLabs Webhook Debug] Signed Content: "${signedContent}"`);
    logger.info(`[PineLabs Webhook Debug] Received Signature (Raw): "${webhookSignature}"`);
    logger.info(`[PineLabs Webhook Debug] Received Signature (Sanitized): "${receivedSig}"`);

    for (const secretBytes of possibleSecrets) {
        const generatedSignature = crypto
            .createHmac('sha256', secretBytes)
            .update(signedContent, 'utf8')
            .digest('base64');

        const generatedBuffer = Buffer.from(generatedSignature, 'utf8');
        const receivedBuffer = Buffer.from(receivedSig, 'utf8');

        if (generatedBuffer.length === receivedBuffer.length) {
            if (crypto.timingSafeEqual(generatedBuffer, receivedBuffer)) {
                logger.info('[PineLabs Webhook Debug] Signature Match Result: true');
                return true;
            }
        }
    }

    logger.warn('[PineLabs Webhook Debug] Signature Match Result: false (failed all key encodings)');
    return false;
};


/**
 * @desc    Handle Pine Labs webhook events
 * @route   POST /api/payment/pinelabs/webhook
 * @access  Public
 */
export const handlePineLabsWebhook = asyncHandler(
    async (req, res) => {

        // 1. Get signature headers
        const webhookId = req.headers['webhook-id'];
        const webhookTimestamp = req.headers['webhook-timestamp'];
        const webhookSignature = req.headers['webhook-signature'];

        // req.body must be raw Buffer
        const rawBody = req.body;

        const isTestMode = process.env.NODE_ENV !== 'production';

        if (!webhookId || !webhookTimestamp || !webhookSignature) {
            if (!isTestMode) {
                throw new ApiError(
                    HTTP_STATUS.BAD_REQUEST,
                    'Missing NxPay webhook signature headers.'
                );
            }
            logger.warn('Missing NxPay webhook signature headers. Bypassing in non-production.');
        }

        const webhookTimestampUnix = Number(webhookTimestamp);
        let webhookTimestampDate = null;

        if (Number.isFinite(webhookTimestampUnix)) {
            const timestampMs = webhookTimestampUnix > 9999999999 ? webhookTimestampUnix : webhookTimestampUnix * 1000;
            webhookTimestampDate = new Date(timestampMs).toISOString();
        } else {
            const parsed = Date.parse(webhookTimestamp);
            if (!Number.isNaN(parsed)) {
                webhookTimestampDate = new Date(parsed).toISOString();
            }
        }


        // 2. Validate timestamp
        let webhookTime = Number(webhookTimestamp);
        if (isNaN(webhookTime)) {
            // Normalize non-standard date format: "2026-08-29 10:07:50:750" → "2026-08-29T10:07:50.750"
            const normalized = String(webhookTimestamp)
                .trim()
                .replace(' ', 'T')              // space → T separator
                .replace(/:(\d{1,4})$/, '.$1'); // last :ms → .ms
            const parsedDate = Date.parse(normalized);
            if (!isNaN(parsedDate)) {
                webhookTime = Math.floor(parsedDate / 1000);
            }
        } else if (webhookTime > 9999999999) {
            // If the timestamp is in milliseconds (13 digits), convert it to seconds
            webhookTime = Math.floor(webhookTime / 1000);
        }

        // ─── Timestamp log (use Unix Seconds value for test signature generator) ───
        logger.info(
            `[PineLabs Webhook] Received ► ` +
            `webhook-id: ${webhookId} | ` +
            `webhook-timestamp (raw): ${webhookTimestamp} | ` +
            `webhook-timestamp (unix seconds): ${webhookTime} | ` +
            `webhook-timestamp (readable): ${webhookTimestampDate}`
        );
        // ─────────────────────────────────────────────────────────────────────────

        const currentTime = Math.floor(Date.now() / 1000);
        const maxAgeInSeconds = 10 * 60; // 10 minutes — allow for network delays

        if (
            !Number.isFinite(webhookTime) ||
            Math.abs(currentTime - webhookTime) > maxAgeInSeconds
        ) {
            if (!isTestMode) {
                throw new ApiError(
                    HTTP_STATUS.UNAUTHORIZED,
                    'Expired or invalid NxPay webhook timestamp.'
                );
            }
            logger.warn(`Expired/invalid webhook timestamp bypassed in non-production: ${webhookTimestamp}`);
        }


        // 3. Verify signature
        const isValidSignature =
            verifyPineLabsWebhookSignature({
                webhookId,
                webhookTimestamp,
                webhookSignature,
                rawBody
            });

        if (!isValidSignature) {
            logger.warn(
                `Invalid Pine Labs webhook signature: ${webhookId}`
            );

            if (!isTestMode) {
                throw new ApiError(
                    HTTP_STATUS.UNAUTHORIZED,
                    'Invalid NxPay webhook signature.'
                );
            }
            logger.info(
                'Bypassing invalid Pine Labs webhook signature check in non-production.'
            );
        }


        // 4. Parse JSON after verification
        let webhookPayload;

        try {
            webhookPayload = JSON.parse(
                rawBody.toString('utf8')
            );
        } catch (error) {
            throw new ApiError(
                HTTP_STATUS.BAD_REQUEST,
                'Invalid NxPay webhook JSON.'
            );
        }


        const {
            event_type,
            data
        } = webhookPayload;

        if (!event_type || !data) {
            throw new ApiError(
                HTTP_STATUS.BAD_REQUEST,
                'Invalid NxPay webhook payload.'
            );
        }


        // 5. Handle ORDER_AUTHORIZED
        if (event_type === 'ORDER_AUTHORIZED') {

            const nxPayOrderId = data.order_id;
            const orderStatus = String(
                data.status || 'AUTHORIZED'
            ).toUpperCase();

            if (!nxPayOrderId) {
                throw new ApiError(
                    HTTP_STATUS.BAD_REQUEST,
                    'NxPay webhook order_id is missing.'
                );
            }


            // Find local order
            const order = await PineLabsOrder.findOne({
                where: {
                    pluralOrderId: nxPayOrderId
                }
            });

            if (!order) {
                throw new ApiError(
                    HTTP_STATUS.NOT_FOUND,
                    'NxPay order not found.'
                );
            }


            const payments = Array.isArray(data.payments)
                ? data.payments
                : [];


            // 6. Update database atomically
            await sequelize.transaction(
                async (transaction) => {

                    // Update order
                    order.pluralStatus = orderStatus;

                    order.rawOrderResponse = {
                        ...(order.rawOrderResponse || {}),
                        webhook: webhookPayload,
                        lastWebhookId: webhookId,
                        lastWebhookEvent: event_type,
                        lastWebhookReceivedAt:
                            new Date().toISOString()
                    };

                    await order.save({ transaction });


                    // Update related payment
                    for (const pinePayment of payments) {

                        let payment = null;

                        // Find by Pine Labs payment ID
                        if (pinePayment.id) {
                            payment =
                                await PineLabsPayment.findOne({
                                    where: {
                                        nxPayPaymentId:
                                            pinePayment.id,
                                        orderId: order.id
                                    },
                                    transaction
                                });
                        }

                        // Fallback by merchant reference
                        if (
                            !payment &&
                            pinePayment.merchant_payment_reference
                        ) {
                            payment =
                                await PineLabsPayment.findOne({
                                    where: {
                                        merchantPaymentReference:
                                            pinePayment
                                                .merchant_payment_reference,
                                        orderId: order.id
                                    },
                                    transaction
                                });
                        }

                        // Fallback to latest pending payment
                        if (!payment) {
                            payment =
                                await PineLabsPayment.findOne({
                                    where: {
                                        orderId: order.id,
                                        status: 'PENDING'
                                    },
                                    order: [['createdAt', 'DESC']],
                                    transaction
                                });
                        }

                        if (!payment) {
                            logger.warn(
                                `Payment not found for order ${nxPayOrderId}`
                            );

                            continue;
                        }

                        // Update payment
                        payment.nxPayOrderId = nxPayOrderId;
                        payment.status = String(
                            pinePayment.status || orderStatus
                        ).toUpperCase();

                        if (pinePayment.id) {
                            payment.nxPayPaymentId =
                                pinePayment.id;
                        }

                        if (pinePayment.payment_amount?.value !== undefined) {
                            payment.amount =
                                Number(pinePayment.payment_amount.value) / 100;
                        }

                        if (pinePayment.payment_amount?.currency) {
                            payment.currency =
                                pinePayment.payment_amount.currency;
                        }

                        if (pinePayment.acquirer_data) {
                            payment.acquirer =
                                pinePayment.acquirer_data;
                        }

                        payment.rawResponse = {
                            ...(payment.rawResponse || {}),
                            webhook: {
                                eventType: event_type,
                                webhookId,
                                webhookTimestamp,
                                data: pinePayment
                            }
                        };

                        await payment.save({ transaction });
                    }
                }
            );


            logger.info(
                `ORDER_AUTHORIZED processed successfully: ${nxPayOrderId}`
            );

            return res.status(HTTP_STATUS.OK).json({
                success: true,
                message: 'ORDER_AUTHORIZED webhook processed successfully.'
            });
        }


        // Acknowledge other webhook events
        logger.info(
            `Unhandled Pine Labs webhook event: ${event_type}`
        );

        return res.status(HTTP_STATUS.OK).json({
            success: true,
            message: `Webhook ${event_type} received.`
        });
    }
);
