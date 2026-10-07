import crypto from 'crypto';
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
import { plCreateNetbankingPayment } from '../../../../../Services/Pinelabs/pinelabs.service.js';
import { normalizePineLabsStatus } from '../../../../../utils/pineLabsHelper.js';


// =============================================================================
// CONTROLLER
// =============================================================================

/**
 * @desc    Initiate a NetBanking payment for a Pine Labs order
 * @route   POST /api/payment/pinelabs/order/:orderId/netbanking/payments
 * @access  Private (User)
 */
export const createPineLabsNetbankingPayment = asyncHandler(async (req, res) => {
    const ipAddress = getClientIp(req);
    const { orderId } = req.params;
    const { payCode } = req.body;

    // ------------------------------------------------------------------
    // 1. Validate request body
    // ------------------------------------------------------------------
    if (!payCode || typeof payCode !== 'string' || payCode.trim().length === 0) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'payCode is required and must be a non-empty string (e.g. "NB1531").'
        );
    }

    const sanitizedPayCode = payCode.trim().toUpperCase();

    // ------------------------------------------------------------------
    // 2. Retrieve local order and verify ownership
    // ------------------------------------------------------------------
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

    if (!order.pluralOrderId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `NxPay order ID is missing. Local UUID: ${order.uuid}`
        );
    }

    // ------------------------------------------------------------------
    // 3. Guard against duplicate PENDING NetBanking payments for same order
    // ------------------------------------------------------------------
    const existingPayment = await PineLabsPayment.findOne({
        where: {
            orderId: order.id,
            paymentMethod: 'NETBANKING',
            status: 'PENDING'
        },
        order: [['createdAt', 'DESC']]
    });

    /*
     * Only reuse an existing PENDING payment if it already has a challengeUrl.
     * If challengeUrl is missing (e.g. Pine Labs returned an incomplete response
     * or the previous attempt failed mid-way), fall through and create a fresh
     * payment with a new merchantPaymentReference so the customer can retry.
     */
    if (existingPayment && existingPayment.challengeUrl) {
        logger.info(
            `Reusing existing pending NetBanking payment for order: ${order.id}`
        );

        const cached = existingPayment.rawResponse || {};

        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(
                HTTP_STATUS.OK,
                {
                    paymentId: existingPayment.uuid,
                    ...cached
                },
                'Existing NetBanking payment found. Redirect the customer to challenge_url.'
            )
        );
    }

    // ------------------------------------------------------------------
    // 4. Get active Pine Labs Access Token
    // ------------------------------------------------------------------
    const { accessToken } = await getValidCachedPineLabsToken(order.userId);

    // ------------------------------------------------------------------
    // 5. Generate unique idempotency key
    // ------------------------------------------------------------------
    const merchantPaymentReference = crypto.randomUUID();

    // ------------------------------------------------------------------
    // 6. Call Pine Labs Create Payment API via Service
    // ------------------------------------------------------------------
    const responseData = await plCreateNetbankingPayment({
        pluralOrderId: order.pluralOrderId,
        amount: Math.round(Number(order.amount) * 100),
        currency: order.currency || 'INR',
        merchantPaymentReference,
        payCode: sanitizedPayCode,
        accessToken,
        userAgent: req.get('user-agent') || ''
    });

    // ------------------------------------------------------------------
    // 7. Find payment details in the response
    // ------------------------------------------------------------------
    const pineLabsPayment =
        responseData.payments?.find(
            p => p.merchant_payment_reference === merchantPaymentReference
        ) || responseData.payments?.[0];

    if (!pineLabsPayment) {
        throw new ApiError(
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            'Payment details missing in NxPay NetBanking response.'
        );
    }

    const nbDetails =
        pineLabsPayment.payment_option?.netbanking_details || {};

    const acquirerData = pineLabsPayment.acquirer_data || {};

    // ------------------------------------------------------------------
    // 8. Persist payment record and sync order status atomically
    // ------------------------------------------------------------------
    let payment;
    await sequelize.transaction(async (t) => {
        payment = await PineLabsPayment.create({
            orderId: order.id,
            nxPayOrderId: responseData.order_id,
            nxPayPaymentId: pineLabsPayment.id,
            merchantPaymentReference: pineLabsPayment.merchant_payment_reference,
            amount: Number(pineLabsPayment.payment_amount?.value || 0) / 100,
            currency: pineLabsPayment.payment_amount?.currency || 'INR',
            paymentMethod: 'NETBANKING',
            status: normalizePineLabsStatus(pineLabsPayment.status || 'PENDING'),
            challengeUrl: responseData.challenge_url || null,

            // NetBanking-specific structured details
            netbanking: {
                payCode: nbDetails.pay_code || sanitizedPayCode,
                txnMode: nbDetails.txn_mode || 'REDIRECT',
                challengeUrl: responseData.challenge_url || null
            },

            // Acquirer information mapped to the common acquirer column
            acquirer: {
                acquirerReference: acquirerData.acquirer_reference || null,
                approvalCode: acquirerData.approval_code || null,
                rrn: acquirerData.rrn || null,
                isAggregator: acquirerData.is_aggregator ?? null
            },

            // Full Pine Labs response for debugging / reconciliation
            rawResponse: responseData,
            ipAddress: ipAddress
        }, { transaction: t });

        // Keep local order status in sync
        if (responseData.status) {
            order.pluralStatus = normalizePineLabsStatus(responseData.status);
            await order.save({ transaction: t });
        }
    });

    // ------------------------------------------------------------------
    // 9. Return response — frontend redirects to challengeUrl
    // ------------------------------------------------------------------
    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                paymentId: payment.uuid,
                ...responseData
            },
            'NetBanking payment initiated successfully. Redirect the customer to challenge_url.'
        )
    );
});
