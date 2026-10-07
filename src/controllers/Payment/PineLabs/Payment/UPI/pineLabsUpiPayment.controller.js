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


/**
 * @desc    Initiate UPI Intent Payment with optional QR support
 * @route   POST /api/payment/pinelabs/order/:orderId/upi/payments
 * @access  Private (User)
 */
export const createPineLabsUpiIntentPayment = asyncHandler(async (req, res) => {
    const ipAddress = getClientIp(req);
    const { orderId } = req.params;

    const { useQr = false } = req.body;

    if (typeof useQr !== 'boolean') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'useQr must be a boolean value.'
        );
    }

    /*
     * 1. Retrieve the local order from the database
     */
    const order = await PineLabsOrder.findOne({
        where: {
            uuid: orderId
        }
    });

    if (!order) {
        throw new ApiError(
            HTTP_STATUS.NOT_FOUND,
            'NxPay order not found.'
        );
    }

    /*
     * Verify Pine Labs order ID exists
     */
    if (!order.pluralOrderId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `NxPay order ID is missing. Local UUID: ${order.uuid}`
        );
    }

    /*
     * 2. Check for an existing duplicate pending UPI payment request
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
        const existingIsQr = existingPayment.upi?.qrCode === true;

        /*
         * Return cached payment only if same requested flow (QR vs Intent)
         * and a challengeUrl exists (meaning Pine Labs responded successfully).
         */
        if (existingIsQr === useQr && existingPayment.challengeUrl) {
            logger.info(`Reusing existing pending UPI payment for order: ${order.id}`);

            const cached = existingPayment.rawResponse || {};

            // Dynamically generate QR code if it is missing in cached response
            if (useQr && !cached.image_url) {
                try {
                    const qrCodeDataUrl = await QRCode.toDataURL(existingPayment.challengeUrl);
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
                    logger.error('Failed to generate QR code for existing pending payment:', error);
                }
            }

            return res.status(HTTP_STATUS.OK).json(
                new ApiResponse(
                    HTTP_STATUS.OK,
                    {
                        paymentId: existingPayment.uuid,
                        ...cached
                    },
                    'Existing UPI payment found.'
                )
            );
        }
    }

    /*
     * 3. Get cached or new active Access Token
     */
    const { accessToken } = await getValidCachedPineLabsToken(order.userId);

    /*
     * 4. Generate unique merchant payment reference
     */
    const merchantPaymentReference = crypto.randomUUID();

    /*
     * 5. Call Pine Labs API via Service
     */
    const responseData = await plCreateUpiPayment({
        accessToken,
        pluralOrderId: order.pluralOrderId,
        amount: Math.round(Number(order.amount) * 100),
        currency: order.currency || 'INR',
        merchantPaymentReference,
        useQr
    });

    /*
     * 6. Find payment details in payments array
     */
    const pineLabsPayment =
        responseData.payments?.find(
            payment => payment.merchant_payment_reference === merchantPaymentReference
        ) || responseData.payments?.[0];

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

    let imageUrl = responseData.image_url || null;

    if (useQr) {
        const intentUrl = responseData.challenge_url || pineLabsPayment.challenge_url || (responseData.payments?.[0]?.challenge_url);

        if (!imageUrl && intentUrl) {
            try {
                const qrCodeDataUrl = await QRCode.toDataURL(intentUrl);
                imageUrl = qrCodeDataUrl;
                responseData.image_url = qrCodeDataUrl;
            } catch (error) {
                logger.error('Failed to generate QR code from intent URL:', error);
            }
        }
    }

    const flow = useQr && imageUrl
        ? 'UPI_INTENT_WITH_QR'
        : 'UPI_INTENT';

    /*
     * 7. Save payment details and update Order status in a Database Transaction
     */
    let payment;
    await sequelize.transaction(async (t) => {
        payment = await PineLabsPayment.create({
            orderId: order.id,
            nxPayOrderId: responseData.order_id,
            nxPayPaymentId: pineLabsPayment.id,
            merchantPaymentReference: pineLabsPayment.merchant_payment_reference,
            amount: Number(pineLabsPayment.payment_amount?.value || 0) / 100,
            currency: pineLabsPayment.payment_amount?.currency || 'INR',
            paymentMethod: 'UPI',
            status: normalizePineLabsStatus(pineLabsPayment.status || 'PENDING'),
            challengeUrl: responseData.challenge_url || null,
            upi: {
                txnMode: responseUpiData.txn_mode || 'INTENT',
                qrCode: useQr,
                challengeUrl: responseData.challenge_url || null,
                imageUrl,
                flow
            },
            acquirer: pineLabsPayment.acquirer_data || null,
            rawResponse: responseData,
            ipAddress: ipAddress
        }, { transaction: t });

        // Sync order status with the response order status
        if (responseData.status) {
            order.pluralStatus = normalizePineLabsStatus(responseData.status);
            await order.save({ transaction: t });
        }
    });

    /*
     * 8. Return response to the client (mirrors Pine Labs response)
     */
    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                paymentId: payment.uuid,
                ...responseData
            },
            useQr
                ? 'UPI Intent payment with QR created successfully.'
                : 'UPI Intent payment created successfully.'
        )
    );
});
