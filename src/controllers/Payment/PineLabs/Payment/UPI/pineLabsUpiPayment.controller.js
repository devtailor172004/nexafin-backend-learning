import crypto from 'crypto';
import QRCode from 'qrcode';
import PineLabsOrder from '../../../../../models/PineLabsOrder.js';
import PineLabsPayment from '../../../../../models/PineLabsPayment.js';
import sequelize from '../../../../../config/db.js';
import { asyncHandler } from '../../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../../utils/ApiError.js';
import { ApiResponse } from '../../../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../../../utils/userHelper.js';
import logger from '../../../../../utils/logger.js';
import { getValidCachedPineLabsToken } from '../../Token/pineLabsToken.controller.js';
import { getClientIp } from '../../../../../utils/getClientIp.js';
import { plCreateUpiPayment } from '../../../../../Services/Pinelabs/pinelabs.service.js';
import { normalizePineLabsStatus } from '../../../../../utils/pineLabsHelper.js';

import {
    claimIdempotency,
    markIdempotencyCompleted,
    markIdempotencyUnknown
} from '../../../../../utils/idempotency.js';


/**
 * @desc    Initiate UPI Intent Payment with optional QR support
 * @route   POST /api/payment/pinelabs/order/:orderId/upi/payments
 * @access  Private (User)
 */

export const createPineLabsUpiIntentPayment = asyncHandler(async (req, res) => {
    const ipAddress = getClientIp(req);
    const { orderId } = req.params;

    // verifyToken has already run on the route.
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    const { useQr = false } = req.body;

    if (typeof useQr !== 'boolean') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'useQr must be a boolean value.'
        );
    }

    /*
     * 1. Retrieve order WITH ownership check.
     */
    const order = await PineLabsOrder.findOne({
        where: {
            uuid: orderId,
            userId
        }
    });

    if (!order) {
        throw new ApiError(
            HTTP_STATUS.NOT_FOUND,
            'NxPay order not found.'
        );
    }

    if (!order.pluralOrderId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `NxPay order ID is missing. Local UUID: ${order.uuid}`
        );
    }

    /*
     * 2. Claim idempotency BEFORE calling Pine Labs.
     */
    const idempotency = await claimIdempotency({
        req,
        userId,
        scope: `pine-labs:upi:${order.id}`,
        ttlMs: 24 * 60 * 60 * 1000
    });

    /*
     * Same request repeated after completion.
     */
    if (idempotency.replay) {
        return res
            .status(idempotency.responseStatus)
            .json(idempotency.responseBody);
    }

    try {
        /*
         * 3. Existing pending UPI payment check.
         */
        const existingPayment = await PineLabsPayment.findOne({
            where: {
                orderId: order.id,
                paymentMethod: 'UPI',
                status: 'PENDING'
            },
            order: [['createdAt', 'DESC']]
        });

        if (existingPayment) {
            const existingIsQr =
                existingPayment.upi?.qrCode === true;

            if (
                existingIsQr === useQr &&
                existingPayment.challengeUrl
            ) {
                const cached = existingPayment.rawResponse || {};

                if (useQr && !cached.image_url) {
                    try {
                        const qrCodeDataUrl =
                            await QRCode.toDataURL(
                                existingPayment.challengeUrl
                            );

                        cached.image_url = qrCodeDataUrl;

                        existingPayment.rawResponse = cached;

                        if (existingPayment.upi) {
                            existingPayment.upi = {
                                ...existingPayment.upi,
                                imageUrl: qrCodeDataUrl,
                                flow: 'UPI_INTENT_WITH_QR'
                            };
                        }

                        await existingPayment.save();
                    } catch (error) {
                        logger.error(
                            'Failed to generate QR code:',
                            error
                        );
                    }
                }

                const responsePayload = new ApiResponse(
                    HTTP_STATUS.OK,
                    {
                        paymentId: existingPayment.uuid,
                        ...cached
                    },
                    'Existing UPI payment found.'
                );

                await markIdempotencyCompleted(
                    idempotency.record,
                    {
                        statusCode: HTTP_STATUS.OK,
                        responseBody: responsePayload,
                        resourceId: existingPayment.uuid
                    }
                );

                return res
                    .status(HTTP_STATUS.OK)
                    .json(responsePayload);
            }
        }

        /*
         * 4. Get provider token.
         */
        const { accessToken } =
            await getValidCachedPineLabsToken(userId);

        /*
         * 5. Generate merchant payment reference.
         */
        const merchantPaymentReference =
            crypto.randomUUID();

        /*
         * 6. Call Pine Labs.
         */
        const responseData =
            await plCreateUpiPayment({
                accessToken,
                pluralOrderId: order.pluralOrderId,
                amount: Math.round(Number(order.amount) * 100),
                currency: order.currency || 'INR',
                merchantPaymentReference,
                useQr
            });

        const pineLabsPayment =
            responseData.payments?.find(
                payment =>
                    payment.merchant_payment_reference ===
                    merchantPaymentReference
            ) ||
            responseData.payments?.[0];

        if (!pineLabsPayment) {
            throw new ApiError(
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                'Payment details missing in NxPay response.'
            );
        }

        const responseUpiData =
            pineLabsPayment.payment_option?.upi_details ||
            pineLabsPayment.payment_option?.upi_data ||
            {};

        let imageUrl =
            responseData.image_url || null;

        if (useQr) {
            const intentUrl =
                responseData.challenge_url ||
                pineLabsPayment.challenge_url ||
                responseData.payments?.[0]?.challenge_url;

            if (!imageUrl && intentUrl) {
                imageUrl =
                    await QRCode.toDataURL(intentUrl);

                responseData.image_url = imageUrl;
            }
        }

        const flow =
            useQr && imageUrl
                ? 'UPI_INTENT_WITH_QR'
                : 'UPI_INTENT';

        /*
         * 7. Save payment + order atomically.
         */
        let payment;

        await sequelize.transaction(async transaction => {
            payment =
                await PineLabsPayment.create(
                    {
                        orderId: order.id,
                        nxPayOrderId:
                            responseData.order_id,
                        nxPayPaymentId:
                            pineLabsPayment.id,
                        merchantPaymentReference:
                            pineLabsPayment.merchant_payment_reference,
                        amount:
                            Number(
                                pineLabsPayment.payment_amount?.value ||
                                0
                            ) / 100,
                        currency:
                            pineLabsPayment.payment_amount?.currency ||
                            'INR',
                        paymentMethod: 'UPI',
                        status:
                            normalizePineLabsStatus(
                                pineLabsPayment.status ||
                                'PENDING'
                            ),
                        challengeUrl:
                            responseData.challenge_url ||
                            null,
                        upi: {
                            txnMode:
                                responseUpiData.txn_mode ||
                                'INTENT',
                            qrCode: useQr,
                            challengeUrl:
                                responseData.challenge_url ||
                                null,
                            imageUrl,
                            flow
                        },
                        acquirer:
                            pineLabsPayment.acquirer_data ||
                            null,
                        rawResponse: responseData,
                        ipAddress
                    },
                    { transaction }
                );

            if (responseData.status) {
                order.pluralStatus =
                    normalizePineLabsStatus(
                        responseData.status
                    );

                await order.save({
                    transaction
                });
            }
        });

        const responsePayload = new ApiResponse(
            HTTP_STATUS.OK,
            {
                paymentId: payment.uuid,
                ...responseData
            },
            useQr
                ? 'UPI Intent payment with QR created successfully.'
                : 'UPI Intent payment created successfully.'
        );

        /*
         * 8. Mark idempotency completed.
         */
        await markIdempotencyCompleted(
            idempotency.record,
            {
                statusCode: HTTP_STATUS.OK,
                responseBody: responsePayload,
                resourceId: payment.uuid
            }
        );

        return res
            .status(HTTP_STATUS.OK)
            .json(responsePayload);

    } catch (error) {
        /*
         * Provider/database outcome may be unknown.
         * Never blindly retry a money-moving request.
         */
        await markIdempotencyUnknown(
            idempotency.record,
            error.message
        );

        throw error;
    }
});
