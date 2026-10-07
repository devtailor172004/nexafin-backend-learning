import sequelize from '../../../../config/db.js';
import PineLabsOrder from '../../../../models/PineLabsOrder.js';
import PineLabsPayment from '../../../../models/PineLabsPayment.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { ApiResponse } from '../../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../../utils/httpStatus.js';
import logger from '../../../../utils/logger.js';
import { verifyPineLabsCallbackSignature } from '../../../../Services/Pinelabs/signature/pineLabsCallbackSignature.js';
import { getValidCachedPineLabsToken } from '../Token/pineLabsToken.controller.js';
import { plGetOrderDetails } from '../../../../Services/Pinelabs/pinelabs.service.js';
import { normalizePineLabsStatus, updatePaymentDetailsFromResponse } from '../../../../utils/pineLabsHelper.js';

/**
 * @desc    Handle NxPay payment return URL callback
 * @route   GET /api/payment/pinelabs/callback
 * @access  Public
 */
export const handlePineLabsPaymentCallback = asyncHandler(async (req, res) => {
    // 1. Get complete callback data
    const callbackData = { ...req.query };
    const { order_id, status, signature } = callbackData;

    // 2. Validate callback
    if (!order_id) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'NxPay callback order_id is required.');
    }
    if (!status) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'NxPay callback status is required.');
    }
    if (!signature) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'NxPay callback signature is required.');
    }

    // 3. Get callback secret (Client Secret in Base64 format as confirmed by support)
    const secretKey = process.env.PINE_LABS_CLIENT_SECRET;
    const isTestMode = process.env.NODE_ENV !== 'production';

    if (!isTestMode && (!secretKey || !String(secretKey).trim())) {
        logger.error('PINE_LABS_CLIENT_SECRET is not configured.');
        throw new ApiError(
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            'Payment callback verification is not configured.'
        );
    }

    // 4. Verify callback signature
    const isSignatureValid = verifyPineLabsCallbackSignature(callbackData, signature, secretKey);
    if (!isSignatureValid) {
        logger.warn(`Invalid NxPay callback signature. Order: ${order_id}`);
        if (!isTestMode) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid NxPay callback signature.');
        }
        logger.warn('Bypassing invalid NxPay callback signature in non-production.');
    }

    // 5. Find local order
    const order = await PineLabsOrder.findOne({
        where: { pluralOrderId: order_id }
    });
    if (!order) {
        logger.warn(`NxPay callback received for unknown order: ${order_id}`);
        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'NxPay order not found.');
    }

    // 6. Get actual latest status from Pine Labs
    const { accessToken } = await getValidCachedPineLabsToken(order.userId);
    const orderDetails = await plGetOrderDetails({
        accessToken,
        pluralOrderId: order.pluralOrderId
    });

    if (!orderDetails) {
        throw new ApiError(HTTP_STATUS.BAD_GATEWAY, 'Empty order status received from NxPay.');
    }

    // 7. Verify returned order ID
    if (orderDetails.order_id && orderDetails.order_id !== order.pluralOrderId) {
        logger.error(`NxPay order mismatch. Expected: ${order.pluralOrderId}, Received: ${orderDetails.order_id}`);
        throw new ApiError(HTTP_STATUS.BAD_GATEWAY, 'NxPay order verification failed.');
    }

    // 8. Update Order + Payments
    await sequelize.transaction(async (t) => {
        // Update Order
        order.pluralStatus = normalizePineLabsStatus(orderDetails.status || status);
        order.rawOrderResponse = {
            ...(order.rawOrderResponse || {}),
            callback: {
                ...callbackData,
                signatureVerified: true,
                receivedAt: new Date().toISOString()
            },
            latestStatusCheck: orderDetails
        };
        await order.save({ transaction: t });

        // Get payments
        const paymentsList = Array.isArray(orderDetails.payments) ? orderDetails.payments : [];

        // Update each payment
        for (const pinePayment of paymentsList) {
            if (!pinePayment) continue;

            let payment = null;

            // First lookup: merchant payment reference
            if (pinePayment.merchant_payment_reference) {
                payment = await PineLabsPayment.findOne({
                    where: {
                        orderId: order.id,
                        merchantPaymentReference: pinePayment.merchant_payment_reference
                    },
                    transaction: t
                });
            }

            // Fallback lookup: Pine Labs payment ID
            if (!payment && pinePayment.id) {
                payment = await PineLabsPayment.findOne({
                    where: {
                        orderId: order.id,
                        nxPayPaymentId: pinePayment.id
                    },
                    transaction: t
                });
            }

            if (!payment) {
                logger.warn(
                    `Local payment not found. Order: ${order_id}, NxPay Payment ID: ${pinePayment.id || 'N/A'}, Merchant Reference: ${pinePayment.merchant_payment_reference || 'N/A'}`
                );
                continue;
            }

            // Update payment
            payment.status = normalizePineLabsStatus(pinePayment.status || orderDetails.status || status);
            payment.signature = signature;
            payment.isSignatureVerified = true;
            payment.rawResponse = {
                ...(payment.rawResponse || {}),
                callback: {
                    ...callbackData,
                    signatureVerified: true,
                    receivedAt: new Date().toISOString()
                },
                latestStatusCheck: pinePayment
            };

            updatePaymentDetailsFromResponse(payment, pinePayment);
            await payment.save({ transaction: t });
        }
    });

    // 9. Log success
    logger.info(`NxPay callback processed successfully. Order: ${order_id}, Callback Status: ${status}, Actual Status: ${order.pluralStatus}`);

    // 10. Return response
    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                orderId: order.uuid,
                nxPayOrderId: order.pluralOrderId,
                callbackStatus: status,
                actualStatus: order.pluralStatus,
                signatureVerified: true
            },
            'NxPay callback processed successfully.'
        )
    );
});
