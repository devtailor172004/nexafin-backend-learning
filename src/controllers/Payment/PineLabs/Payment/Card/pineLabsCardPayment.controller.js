import PineLabsOrder from '../../../../../models/PineLabsOrder.js';
import PineLabsPayment from '../../../../../models/PineLabsPayment.js';
import sequelize from '../../../../../config/db.js';
import { asyncHandler } from '../../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../../utils/ApiError.js';
import { ApiResponse } from '../../../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../../../utils/userHelper.js';
import { getValidCachedPineLabsToken } from '../../Token/pineLabsToken.controller.js';
import { getClientIp } from '../../../../../utils/getClientIp.js';
import {
    plChargeCard,
    plGenerateOtp,
    plResendOtp,
    plSubmitOtp,
    plGetCardDetails,
    plAuthorizePayment,
    plGetOrderDetails
} from '../../../../../Services/Pinelabs/pinelabs.service.js';
import { normalizePineLabsStatus, isPineLabsPollingRequired, updatePaymentDetailsFromResponse } from '../../../../../utils/pineLabsHelper.js';


/**
 * @desc    Charge a raw card payment for a Pine Labs Plural order
 * @route   POST /api/payment/pinelabs/order/:orderId/payments
 * @access  Private (User)
 */
export const chargeCardPayment = asyncHandler(async (req, res) => {
    const ipAddress = getClientIp(req);
    const { orderId } = req.params;

    const { payments } = req.body;

    if (!payments || !Array.isArray(payments) || payments.length === 0) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Payment details are required.");
    }

    const paymentInfo = payments[0];
    const cardDetails = paymentInfo.payment_option?.card_details;

    if (!cardDetails) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Card details are required.");
    }

    const { card_number, expiry_month, expiry_year, cvv, name, save } = cardDetails;

    if (!card_number || !expiry_month || !expiry_year || !cvv || !name) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid card details. Number, expiry month, expiry year, cvv, and name are required.");
    }

    // Retrieve the internal order from the database by UUID
    const internalOrder = await PineLabsOrder.findOne({
        where: { uuid: orderId }
    });
    if (!internalOrder) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Order not found in database.");
    }

    if (!internalOrder.pluralOrderId) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Order is not initialized in NxPay system.");
    }

    const nxPayOrderId = internalOrder.pluralOrderId;

    // Use value and currency from payload if provided, otherwise fallback to order amount and default currency
    const paymentVal = paymentInfo.payment_amount?.value !== undefined
        ? Math.round(Number(paymentInfo.payment_amount.value) * 100)
        : Math.round(Number(internalOrder.amount) * 100);
    const paymentCurr = paymentInfo.payment_amount?.currency || internalOrder.currency || "INR";
    const merchantPaymentReference = `PAY_${internalOrder.id}_${Date.now()}`;

    // Get active Pine Labs access token
    const { accessToken } = await getValidCachedPineLabsToken(internalOrder.userId);

    // Call Pine Labs Payments API via Service
    const responseData = await plChargeCard({
        accessToken,
        pluralOrderId: nxPayOrderId,
        merchantPaymentReference,
        amount: paymentVal,
        currency: paymentCurr,
        cardDetails: {
            card_number,
            expiry_month,
            expiry_year,
            cvv,
            name,
            save
        }
    });

    const paymentItem = responseData.payments?.[0];
    const cardData = paymentItem?.payment_option?.card_data;
    const acquirerData = paymentItem?.acquirer_data;

    // Save payment attempt to the database atomically
    let createdPayment;
    await sequelize.transaction(async (t) => {
        createdPayment = await PineLabsPayment.create({
            orderId: internalOrder.id,
            nxPayOrderId: responseData.order_id || nxPayOrderId,
            nxPayPaymentId: paymentItem?.id || null,
            merchantPaymentReference: paymentItem?.merchant_payment_reference || merchantPaymentReference,
            amount: Number(paymentVal) / 100,
            currency: paymentCurr,
            paymentMethod: "CARD",
            status: paymentItem?.status || responseData.status || "PENDING",
            challengeUrl: responseData.challenge_url || null,
            card: cardData ? {
                last4: cardData.last4_digit || null,
                network: cardData.network_name || null,
                type: cardData.card_type || null
            } : null,
            acquirer: acquirerData ? {
                approvalCode: acquirerData.approval_code || null,
                rrn: acquirerData.rrn || null,
                acquirerReference: acquirerData.acquirer_reference || null
            } : null,
            rawResponse: responseData,
            responseCode: paymentItem?.response_code || responseData.response_code || null,
            responseMessage: paymentItem?.response_message || responseData.response_message || null,
            transactionId: paymentItem?.transaction_id || responseData.transaction_id || null,
            threeDsVersion: paymentItem?.authentication_info?.three_ds_version || null,
            authenticationType: paymentItem?.authentication_info?.authentication_type || null,
            eci: paymentItem?.authentication_info?.eci || null,
            ipAddress: ipAddress
        }, { transaction: t });

        // Update the order's status if returned in response
        if (responseData.status) {
            internalOrder.pluralStatus = responseData.status;
            await internalOrder.save({ transaction: t });
        }
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                paymentId: createdPayment.uuid,
                ...responseData
            },
            "NxPay payment charged successfully!"
        )
    );
});

/**
 * @desc    Generate OTP for a Card Payment Authentication
 * @route   POST /api/payment/pinelabs/payments/:paymentId/otp/generate
 * @access  Private (User)
 */
export const generatePineLabsOtp = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;

    // Retrieve the payment record from the database by UUID, ensuring ownership through parent order
    const payment = await PineLabsPayment.findOne({
        where: { uuid: paymentId },
        include: [{
            model: PineLabsOrder,
            as: 'PineLabsOrder'
        }]
    });

    if (!payment) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Payment attempt not found.");
    }

    if (payment.status !== 'PENDING') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "OTP cannot be generated for this payment."
        );
    }

    if (!payment.nxPayPaymentId) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "No active NxPay transaction ID found for this payment attempt.");
    }

    const { accessToken } = await getValidCachedPineLabsToken(payment.PineLabsOrder.userId);

    // Call Pine Labs Generate OTP API via Service
    const jsonRes = await plGenerateOtp({
        accessToken,
        nxPayPaymentId: payment.nxPayPaymentId
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            jsonRes,
            "OTP generated successfully."
        )
    );
});

/**
 * @desc    Resend OTP for a Card Payment Authentication
 * @route   POST /api/payment/pinelabs/payments/:paymentId/otp/resend
 * @access  Private (User)
 */
export const resendPineLabsOtp = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;

    // Retrieve payment and verify ownership through parent order
    const payment = await PineLabsPayment.findOne({
        where: {
            uuid: paymentId
        },
        include: [{
            model: PineLabsOrder,
            as: 'PineLabsOrder'
        }]
    });

    if (!payment) {
        throw new ApiError(
            HTTP_STATUS.NOT_FOUND,
            "Payment attempt not found."
        );
    }

    if (!payment.nxPayPaymentId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "No active NxPay transaction ID found for this payment attempt."
        );
    }

    const { accessToken } = await getValidCachedPineLabsToken(payment.PineLabsOrder.userId);

    // Call Resend OTP API via Service
    const jsonResponse = await plResendOtp({
        accessToken,
        nxPayPaymentId: payment.nxPayPaymentId
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            jsonResponse,
            "OTP resent successfully."
        )
    );
});

/**
 * @desc    Submit OTP for a Card Payment Authentication
 * @route   POST /api/payment/pinelabs/payments/:paymentId/otp/submit
 * @access  Private (User)
 */
export const submitPineLabsOtp = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;
    const { otp } = req.body;

    if (!otp || String(otp).trim().length === 0) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "OTP is required.");
    }

    // Retrieve the payment record from the database by UUID, ensuring ownership through parent order
    const payment = await PineLabsPayment.findOne({
        where: { uuid: paymentId },
        include: [{
            model: PineLabsOrder,
            as: 'PineLabsOrder'
        }]
    });

    if (!payment) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Payment attempt not found.");
    }

    if (!payment.nxPayPaymentId) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "No active NxPay transaction ID found for this payment attempt.");
    }

    if (payment.status !== 'PENDING') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `OTP submission is not allowed. Current payment status: ${payment.status}.`
        );
    }

    const { accessToken } = await getValidCachedPineLabsToken(payment.PineLabsOrder.userId);

    // Call Pine Labs Submit OTP API via Service
    const responseData = await plSubmitOtp({
        accessToken,
        nxPayPaymentId: payment.nxPayPaymentId,
        otp
    });

    const paymentItem = responseData.payments?.[0] || responseData;
    const cardData = paymentItem?.payment_option?.card_data;
    const acquirerData = paymentItem?.acquirer_data;

    let finalStatus = paymentItem?.status || responseData.status || payment.status;
    const isPollingRequired = isPineLabsPollingRequired(finalStatus, responseData);
    finalStatus = isPollingRequired ? 'PENDING' : normalizePineLabsStatus(finalStatus);

    // Update payment attempt and order status atomically
    await sequelize.transaction(async (t) => {
        payment.status = finalStatus;
        payment.rawResponse = responseData;

        if (cardData) {
            payment.card = {
                last4: cardData.last4_digit || null,
                network: cardData.network_name || null,
                type: cardData.card_type || null
            };
        }

        updatePaymentDetailsFromResponse(payment, paymentItem);

        payment.threeDsVersion = paymentItem?.authentication_info?.three_ds_version || payment.threeDsVersion;
        payment.authenticationType = paymentItem?.authentication_info?.authentication_type || payment.authenticationType;
        payment.eci = paymentItem?.authentication_info?.eci || payment.eci;

        await payment.save({ transaction: t });

        // Update parent order status
        const order = payment.PineLabsOrder;
        if (order && finalStatus) {
            order.pluralStatus = finalStatus;
            await order.save({ transaction: t });
        }
    });

    let message;
    if (isPollingRequired) {
        message = 'OTP verified. Payment is being confirmed.';
    } else if (finalStatus === 'PROCESSED' || finalStatus === 'AUTHORIZED') {
        message = 'OTP verified and payment processed successfully.';
    } else {
        message = `OTP submitted. Current payment status: ${finalStatus}`;
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                ...payment.toJSON(),
                next: isPollingRequired ? ['POLL'] : []
            },
            message
        )
    );
});

/**
 * @desc    Retrieve card details (network, issuer, native OTP support) from Pine Labs
 * @route   POST /api/payment/pinelabs/card-details
 * @access  Private (User)
 */
export const getPineLabsCardDetails = asyncHandler(async (req, res) => {
    let userId;
    if (req.user) {
        userId = req.user.id;
    } else {
        const { orderId } = req.body;
        if (!orderId) {
            throw new ApiError(
                HTTP_STATUS.BAD_REQUEST,
                "orderId is required when authorization token is not provided."
            );
        }
        const order = await PineLabsOrder.findOne({
            where: { uuid: orderId }
        });
        if (!order) {
            throw new ApiError(
                HTTP_STATUS.NOT_FOUND,
                "Order not found."
            );
        }
        userId = order.userId;
    }

    const { amount, card_details } = req.body;

    if (!card_details || !Array.isArray(card_details) || card_details.length === 0) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "card_details array is required and cannot be empty."
        );
    }

    const cardDetailItem = card_details[0];
    const cardNumber = cardDetailItem?.payment_identifier;
    const sanitizedCardNumber = String(cardNumber || '').replace(/\D/g, '');

    if (sanitizedCardNumber.length < 6) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "A valid payment_identifier (card number) with at least the first 6 digits/BIN is required."
        );
    }

    if (
        amount === undefined ||
        amount === null ||
        isNaN(Number(amount)) ||
        Number(amount) <= 0
    ) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "A valid amount greater than 0 is required."
        );
    }

    const { accessToken } = await getValidCachedPineLabsToken(userId);

    // Call Get Card Details via Service
    const jsonRes = await plGetCardDetails({
        accessToken,
        cardNumber: sanitizedCardNumber,
        amount: Math.round(Number(amount) * 100)
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            jsonRes,
            "Card details retrieved successfully from NxPay."
        )
    );
});

/**
 * @desc    Decoupled Authorization for Apple Pay
 * @route   POST /api/payment/pinelabs/payments/:paymentId/authorize
 * @access  Private (User)
 */
export const authorizePineLabsPayment = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;

    const {
        decrypted_card_details,
        acquirer_payment_details,
        authentication_type
    } = req.body;

    if (!decrypted_card_details || typeof decrypted_card_details !== "object") {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "decrypted_card_details are required."
        );
    }

    const {
        pan,
        cvv,
        card_holder_name,
        token,
        expiration_month,
        expiration_year,
        cryptogram,
        cavv,
        eci
    } = decrypted_card_details;

    // Validate mandatory decrypted card details
    if (!pan) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "decrypted_card_details.pan is required."
        );
    }

    if (!cvv) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "decrypted_card_details.cvv is required."
        );
    }

    if (!expiration_month) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "decrypted_card_details.expiration_month is required."
        );
    }

    if (!expiration_year) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "decrypted_card_details.expiration_year is required."
        );
    }

    if (!cryptogram) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "decrypted_card_details.cryptogram is required."
        );
    }

    if (!authentication_type) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "authentication_type is required."
        );
    }

    const payment = await PineLabsPayment.findOne({
        where: {
            uuid: paymentId
        },
        include: [
            {
                model: PineLabsOrder,
                as: "PineLabsOrder"
            }
        ]
    });

    if (!payment) {
        throw new ApiError(
            HTTP_STATUS.NOT_FOUND,
            "Payment attempt not found."
        );
    }

    const nxPayOrderId = payment.PineLabsOrder?.pluralOrderId;
    const nxPayPaymentId = payment.nxPayPaymentId;

    if (!nxPayOrderId || !nxPayPaymentId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Order or Payment is not properly initialized in NxPay system."
        );
    }

    const { accessToken } = await getValidCachedPineLabsToken(payment.PineLabsOrder.userId);

    // Call Authorize Payment API via Service
    const responseData = await plAuthorizePayment({
        accessToken,
        pluralOrderId: nxPayOrderId,
        nxPayPaymentId,
        decryptedCardDetails: decrypted_card_details,
        authenticationType: authentication_type,
        acquirerPaymentDetails: acquirer_payment_details
    });

    const paymentItem = responseData.payments?.[0];

    if (!paymentItem) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Payment authorization response does not contain payment details."
        );
    }

    const cardData = paymentItem?.payment_option?.card_data;
    const acquirerData = paymentItem?.acquirer_data;
    const authenticationInfo = paymentItem?.authentication_info;

    await sequelize.transaction(async (t) => {
        // Update payment status
        payment.status =
            paymentItem?.status ||
            responseData?.status ||
            payment.status;

        payment.rawResponse = responseData;

        if (cardData) {
            payment.card = {
                last4: cardData?.last4_digit || null,
                network: cardData?.network_name || null,
                type: cardData?.card_type || null
            };
        }

        if (acquirerData) {
            payment.acquirer = {
                approvalCode:
                    acquirerData?.approval_code || null,
                rrn:
                    acquirerData?.rrn || null,
                acquirerReference:
                    acquirerData?.acquirer_reference || null
            };
        }

        payment.responseCode =
            paymentItem?.response_code ||
            responseData?.response_code ||
            payment.responseCode;

        payment.responseMessage =
            paymentItem?.response_message ||
            responseData?.response_message ||
            payment.responseMessage;

        payment.transactionId =
            paymentItem?.transaction_id ||
            responseData?.transaction_id ||
            payment.transactionId;

        payment.threeDsVersion =
            authenticationInfo?.three_ds_version ||
            payment.threeDsVersion;

        payment.authenticationType =
            authenticationInfo?.authentication_type ||
            payment.authenticationType;

        payment.eci =
            authenticationInfo?.eci ||
            payment.eci;

        await payment.save({
            transaction: t
        });

        const order = payment.PineLabsOrder;

        if (order && responseData?.status) {
            order.pluralStatus = responseData.status;

            await order.save({
                transaction: t
            });
        }
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            payment,
            "NxPay payment authorized successfully!"
        )
    );
});


/**
 * @desc    Get current status of a payment from Pine Labs and update DB
 * @route   GET /api/payment/pinelabs/payments/:paymentId/status
 * @access  Private (User)
 */
export const getPineLabsPaymentStatus = asyncHandler(async (req, res) => {
    const { paymentId } = req.params;

    // 1. Fetch payment attempt and ensure ownership
    const payment = await PineLabsPayment.findOne({
        where: { uuid: paymentId },
        include: [{
            model: PineLabsOrder,
            as: 'PineLabsOrder'
        }]
    });

    if (!payment) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Payment attempt not found.");
    }

    if (!payment.nxPayOrderId) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Payment does not have an active NxPay Order ID.");
    }

    const { accessToken } = await getValidCachedPineLabsToken(payment.PineLabsOrder.userId);

    // 2. Query Pine Labs status API
    const orderDetails = await plGetOrderDetails({
        accessToken,
        pluralOrderId: payment.nxPayOrderId
    });

    // 3. Find this specific payment inside the order's payments array
    const paymentsList = Array.isArray(orderDetails.payments) ? orderDetails.payments : [];
    const pinePayment = paymentsList.find(
        p => p.id === payment.nxPayPaymentId || p.merchant_payment_reference === payment.merchantPaymentReference
    ) || paymentsList[0];

    // Determine final status and normalize it
    const finalStatus = normalizePineLabsStatus(pinePayment?.status || orderDetails.status || payment.status);

    // 4. Update internal database tables atomically
    await sequelize.transaction(async (t) => {
        payment.status = finalStatus;
        payment.rawResponse = orderDetails;

        updatePaymentDetailsFromResponse(payment, pinePayment);

        await payment.save({ transaction: t });

        const order = payment.PineLabsOrder;
        if (order && orderDetails.status) {
            order.pluralStatus = normalizePineLabsStatus(orderDetails.status);
            await order.save({ transaction: t });
        }
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            payment,
            `Payment status retrieved: ${payment.status}`
        )
    );
});

