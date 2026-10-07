import PineLabsOrder from '../../../../models/PineLabsOrder.js';
import PineLabsPayment from '../../../../models/PineLabsPayment.js';
import sequelize from '../../../../config/db.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { ApiResponse } from '../../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../../utils/userHelper.js';
import logger from '../../../../utils/logger.js';
import { getValidCachedPineLabsToken } from '../Token/pineLabsToken.controller.js';
import { getClientIp } from '../../../../utils/getClientIp.js';
import { plCreateOrder, plCaptureAuthorizedOrder, plCancelAuthorizedOrder, plGetOrderDetails } from '../../../../Services/Pinelabs/pinelabs.service.js';
import { normalizePineLabsStatus, updatePaymentDetailsFromResponse } from '../../../../utils/pineLabsHelper.js';


// =============================================================================
// CONTROLLER
// =============================================================================

/**
 * @desc    Create a Payment Order in Pine Labs Plural system
 * @route   POST /api/payment/pinelabs/order
 * @access  Private (User)
 */
export const createPaymentOrder = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    let { amount, notes, preAuth, callbackUrl, failureCallbackUrl } = req.body;

    // Fallback: extract amount from nested order_amount.value if not provided at root
    if (amount === undefined || amount === null) {
        if (req.body.order_amount && req.body.order_amount.value !== undefined) {
            amount = req.body.order_amount.value;
        }
    }

    // Validation
    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) <= 0) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "A valid order amount greater than 0 is required.");
    }

    if (!callbackUrl) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "callbackUrl is required in the request body.");
    }
    if (!failureCallbackUrl) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "failureCallbackUrl is required in the request body.");
    }

    // Keep amount as it is (do not multiply by 100)
    const orderAmount = Math.round(Number(amount) * 100);

    // Extract customer details strictly from request body
    const bodyCustomer = req.body.purchase_details?.customer;
    if (!bodyCustomer) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Customer details are required in purchase_details.customer."
        );
    }

    const customerEmail = bodyCustomer.email_id;
    const firstName = bodyCustomer.first_name;
    const lastName = bodyCustomer.last_name;
    const mobileNumber = bodyCustomer.mobile_number;
    const countryCode = bodyCustomer.country_code || '91';
    const customerId = bodyCustomer.customer_id || `CUST_${userId}`;

    // Validation of mandatory customer fields
    if (!customerEmail || !firstName || !lastName || !mobileNumber) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Invalid customer details. email_id, first_name, last_name, and mobile_number are all required."
        );
    }

    // Generate unique merchant order reference
    const merchantOrderRef = `ORD_${Date.now()}_${userId}`;
    const orderNotes = notes || `Order payment for user ${userId}`;

    // Get active Pine Labs access token
    const { accessToken } = await getValidCachedPineLabsToken(userId);

    // Call Pine Labs Create Order API via Service
    const orderData = await plCreateOrder({
        accessToken,
        merchantOrderRef,
        orderAmount,
        notes: orderNotes,
        callbackUrl,
        failureCallbackUrl,
        customer: {
            customer_id: customerId,
            email_id: customerEmail,
            first_name: firstName,
            last_name: lastName,
            mobile_number: mobileNumber,
            country_code: countryCode
        },
        preAuth: preAuth === true || preAuth === 'true'
    });


    if (!orderData || !orderData.order_id) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Invalid response received from NxPay order creation service."
        );
    }

    // Extract client IP address securely
    const ipAddress = getClientIp(req);

    // Save order details to the database atomically
    let createdOrder;
    await sequelize.transaction(async (t) => {
        createdOrder = await PineLabsOrder.create({
            userId: userId,
            merchantOrderRef: merchantOrderRef,
            pluralOrderId: orderData.order_id,
            amount: Number(amount),
            currency: 'INR',
            callbackUrl: callbackUrl,
            failureCallbackUrl: failureCallbackUrl,
            notes: orderNotes,
            allowedPaymentMethods: orderData.allowed_payment_methods || [],
            customerId: orderData.purchase_details?.customer?.customer_id,
            customerEmail: customerEmail,
            pluralStatus: orderData.status || 'CREATED',
            preAuth: orderData.pre_auth ?? false,
            rawOrderResponse: orderData,
            ipAddress: ipAddress
        }, { transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            createdOrder,
            "NxPay payment order initialized successfully!"
        )
    );
});

export const capturePineLabsAuthorizedOrder = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    const { orderId } = req.params;
    const {
        merchant_capture_reference,
        capture_amount
    } = req.body;

    // ------------------------------------------------------------------
    // 1. Validate request
    // ------------------------------------------------------------------
    if (
        merchant_capture_reference !== undefined &&
        (
            typeof merchant_capture_reference !== 'string' ||
            merchant_capture_reference.trim().length === 0
        )
    ) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'merchant_capture_reference must be a non-empty string.'
        );
    }

    if (!capture_amount || typeof capture_amount !== 'object') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'capture_amount is required.'
        );
    }

    const captureValue = Math.round(Number(capture_amount.value) * 100);
    const captureCurrency =
        String(capture_amount.currency || 'INR').trim().toUpperCase();

    if (isNaN(captureValue) || !Number.isInteger(captureValue) || captureValue <= 0) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'capture_amount.value must be a valid positive number.'
        );
    }

    if (!captureCurrency) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'capture_amount.currency is required.'
        );
    }

    // ------------------------------------------------------------------
    // 2. Retrieve local order and verify ownership
    // orderId here is local PineLabsOrder.uuid
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // 3. Verify Pine Labs order ID
    // ------------------------------------------------------------------
    if (!order.pluralOrderId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `NxPay order ID is missing. Local UUID: ${order.uuid}`
        );
    }

    // ------------------------------------------------------------------
    // 4. Capture API is only for pre-authorized orders
    // ------------------------------------------------------------------
    if (!order.preAuth) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'This order is not a pre-authorized order and cannot be captured.'
        );
    }

    // ------------------------------------------------------------------
    // 5. Validate currency against the original order
    // ------------------------------------------------------------------
    if (
        order.currency &&
        captureCurrency !== String(order.currency).toUpperCase()
    ) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `Capture currency must be ${order.currency}.`
        );
    }

    // ------------------------------------------------------------------
    // 6. Capture amount cannot exceed original order amount
    // ------------------------------------------------------------------
    if (captureValue > Math.round(Number(order.amount) * 100)) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'Capture amount cannot be greater than the order amount.'
        );
    }

    // ------------------------------------------------------------------
    // 7. Find the latest AUTHORIZED payment for this order
    // ------------------------------------------------------------------
    const payment = await PineLabsPayment.findOne({
        where: {
            orderId: order.id,
            status: 'AUTHORIZED'
        },
        order: [['createdAt', 'DESC']]
    });

    if (!payment) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'No authorized payment found for this order.'
        );
    }

    // ------------------------------------------------------------------
    // 8. Prevent duplicate capture
    // ------------------------------------------------------------------
    if (
        payment.merchantCaptureReference ||
        payment.captureData ||
        payment.status === 'PROCESSED'
    ) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'This payment has already been captured.'
        );
    }

    // ------------------------------------------------------------------
    // 9. Generate or use unique merchant capture reference
    // ------------------------------------------------------------------
    const merchantCaptureReference =
        merchant_capture_reference?.trim() || crypto.randomUUID();

    // ------------------------------------------------------------------
    // 10. Get active Pine Labs access token
    // ------------------------------------------------------------------
    const { accessToken } =
        await getValidCachedPineLabsToken(userId);

    // ------------------------------------------------------------------
    // 11. Call Pine Labs Capture Authorized Order API
    // PUT /api/pay/v1/orders/{order_id}/capture
    // ------------------------------------------------------------------
    const responseData = await plCaptureAuthorizedOrder({
        accessToken,
        pluralOrderId: order.pluralOrderId,
        merchantCaptureReference,
        captureAmount: captureValue,
        currency: captureCurrency
    });

    // ------------------------------------------------------------------
    // 12. Find the captured payment in Pine Labs response
    // ------------------------------------------------------------------
    const responsePayment =
        responseData.payments?.find(
            p =>
                p.id === payment.nxPayPaymentId ||
                p.merchant_payment_reference ===
                payment.merchantPaymentReference
        ) || responseData.payments?.[0];

    // ------------------------------------------------------------------
    // 13. Save capture response and update local records atomically
    // ------------------------------------------------------------------
    await sequelize.transaction(async (t) => {
        payment.merchantCaptureReference =
            merchantCaptureReference;

        payment.captureAmount = captureValue;
        payment.captureCurrency = captureCurrency;

        payment.captureData =
            responsePayment?.capture_data || null;

        payment.capturedAt =
            responsePayment?.capture_data?.[0]?.created_at
                ? new Date(
                    responsePayment.capture_data[0].created_at
                )
                : new Date();

        // Keep payment status in sync with Pine Labs response
        if (responsePayment?.status) {
            payment.status = responsePayment.status;
        }

        payment.rawResponse = responseData;

        await payment.save({ transaction: t });

        // Keep order status in sync with Pine Labs response
        if (responseData.status) {
            order.pluralStatus = responseData.status;
            order.rawOrderResponse = responseData;

            await order.save({ transaction: t });
        }
    });

    // ------------------------------------------------------------------
    // 14. Return response
    // ------------------------------------------------------------------
    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                paymentId: payment.uuid,
                merchantCaptureReference,
                ...responseData
            },
            'Authorized payment order captured successfully.'
        )
    );
});


/**
 * @desc    Cancel a pre-authorized payment order in Pine Labs Plural system
 * @route   PUT /api/payment/pinelabs/orders/:orderId/cancel
 * @access  Private (User)
 */
export const cancelPineLabsOrder = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    const { orderId } = req.params;

    // ------------------------------------------------------------------
    // 1. Find the local Pine Labs order
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // 2. Verify Pine Labs order ID
    // ------------------------------------------------------------------
    if (!order.pluralOrderId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `NxPay order ID is missing. Local UUID: ${order.uuid}`
        );
    }

    // ------------------------------------------------------------------
    // 3. Cancel API is only for pre-authorized orders
    // ------------------------------------------------------------------
    if (!order.preAuth) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'This order is not a pre-authorized order and cannot be cancelled.'
        );
    }

    // ------------------------------------------------------------------
    // 4. Find the latest payment for this order
    // ------------------------------------------------------------------
    const payment = await PineLabsPayment.findOne({
        where: {
            orderId: order.id
        },
        order: [['createdAt', 'DESC']]
    });

    // ------------------------------------------------------------------
    // 5. Prevent cancelling already processed or cancelled payments
    // ------------------------------------------------------------------
    if (payment && payment.status === 'PROCESSED') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'This payment has already been captured (processed) and cannot be cancelled.'
        );
    }

    if (payment && payment.status === 'CANCELLED') {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'This payment has already been cancelled.'
        );
    }

    // ------------------------------------------------------------------
    // 6. Get active Pine Labs access token
    // ------------------------------------------------------------------
    const { accessToken } = await getValidCachedPineLabsToken(userId);

    // ------------------------------------------------------------------
    // 7. Call Pine Labs Cancel Pre-Authorized Order API
    // ------------------------------------------------------------------
    const responseData = await plCancelAuthorizedOrder({
        accessToken,
        pluralOrderId: order.pluralOrderId
    });

    // ------------------------------------------------------------------
    // 8. Update local database records atomically
    // ------------------------------------------------------------------
    await sequelize.transaction(async (t) => {
        const now = new Date();

        order.pluralStatus = responseData.status || 'CANCELLED';
        order.rawOrderResponse = responseData;
        order.cancelledAt = now;
        await order.save({ transaction: t });

        if (payment) {
            const responsePayment = responseData.payments?.find(
                p =>
                    p.id === payment.nxPayPaymentId ||
                    p.merchant_payment_reference ===
                    payment.merchantPaymentReference
            ) || responseData.payments?.[0];

            payment.status = responsePayment?.status || 'CANCELLED';
            payment.cancelledAt = now;
            payment.rawResponse = {
                ...(payment.rawResponse || {}),
                cancelResponse: responseData
            };
            await payment.save({ transaction: t });
        }
    });

    // ------------------------------------------------------------------
    // 9. Return response
    // ------------------------------------------------------------------
    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                orderId: order.uuid,
                nxPayOrderId: order.pluralOrderId,
                ...responseData
            },
            'Pre-authorized payment order cancelled successfully.'
        )
    );
});

/**
 * @desc    Get details and status of a payment order from Pine Labs and update DB
 * @route   GET /api/payment/pinelabs/orders/:orderId
 * @access  Private (User)
 */
export const getPineLabsOrderDetails = asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    // 1. Fetch the local order
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
            `NxPay order ID is missing for local order: ${order.uuid}`
        );
    }

    // 2. Get active Pine Labs access token
    const { accessToken } = await getValidCachedPineLabsToken(order.userId);

    // 3. Query Pine Labs status API
    const responseData = await plGetOrderDetails({
        accessToken,
        pluralOrderId: order.pluralOrderId
    });

    // 4. Determine final status and normalize it
    const normalizedOrderStat = normalizePineLabsStatus(responseData.status);

    // 5. Update local database tables atomically
    await sequelize.transaction(async (t) => {
        order.pluralStatus = normalizedOrderStat;
        order.rawOrderResponse = responseData;
        await order.save({ transaction: t });

        // Update any associated payments status
        const paymentsList = Array.isArray(responseData.payments) ? responseData.payments : [];
        for (const pinePayment of paymentsList) {
            const payment = await PineLabsPayment.findOne({
                where: {
                    orderId: order.id,
                    merchantPaymentReference: pinePayment.merchant_payment_reference
                }
            });
            if (payment) {
                payment.status = normalizePineLabsStatus(pinePayment.status || payment.status);
                payment.rawResponse = responseData;
                updatePaymentDetailsFromResponse(payment, pinePayment);
                await payment.save({ transaction: t });
            }
        }
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                order,
                nxPayDetails: responseData
            },
            "NxPay order details retrieved successfully."
        )
    );
});

/**
 * @desc    Initiate a payment order and return a secure rebranded payment checkout URL
 * @route   POST /api/payment/NxPay/initiate
 * @access  Private (User/Merchant)
 */
export const initiatePayment = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    let { amount, notes, preAuth, pre_auth, callbackUrl, failureCallbackUrl } = req.body;

    // Fallback: extract amount from nested order_amount.value if not provided at root
    if (amount === undefined || amount === null) {
        if (req.body.order_amount && req.body.order_amount.value !== undefined) {
            amount = req.body.order_amount.value;
        }
    }

    // Validation
    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) <= 0) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "A valid order amount greater than 0 is required.");
    }

    if (!callbackUrl) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "callbackUrl is required in the request body.");
    }
    if (!failureCallbackUrl) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "failureCallbackUrl is required in the request body.");
    }

    const orderAmount = Math.round(Number(amount) * 100);

    // Extract customer details strictly from request body
    const bodyCustomer = req.body.purchase_details?.customer;
    if (!bodyCustomer) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Customer details are required in purchase_details.customer."
        );
    }

    const customerEmail = bodyCustomer.email_id;
    const firstName = bodyCustomer.first_name;
    const lastName = bodyCustomer.last_name;
    const mobileNumber = bodyCustomer.mobile_number;
    const countryCode = bodyCustomer.country_code || '91';
    const customerId = bodyCustomer.customer_id || `CUST_${userId}`;

    // Validation of mandatory customer fields
    if (!customerEmail || !firstName || !lastName || !mobileNumber) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Invalid customer details. email_id, first_name, last_name, and mobile_number are all required."
        );
    }

    // Generate unique merchant order reference
    const merchantOrderRef = `ORD_${Date.now()}_${userId}`;
    const orderNotes = notes || `Order payment for user ${userId}`;

    // Get active Pine Labs access token
    const { accessToken } = await getValidCachedPineLabsToken(userId);

    const activePreAuth = preAuth ?? pre_auth;
    const isPreAuth = activePreAuth === true || activePreAuth === 'true';

    // Call Pine Labs Create Order API via Service
    const orderData = await plCreateOrder({
        accessToken,
        merchantOrderRef,
        orderAmount,
        notes: orderNotes,
        callbackUrl,
        failureCallbackUrl,
        customer: {
            customer_id: customerId,
            email_id: customerEmail,
            first_name: firstName,
            last_name: lastName,
            mobile_number: mobileNumber,
            country_code: countryCode
        },
        preAuth: isPreAuth
    });

    if (!orderData || !orderData.order_id) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Invalid response received from NxPay order creation service."
        );
    }

    // Extract client IP address securely
    const ipAddress = getClientIp(req);

    // Save order details to the database atomically
    let createdOrder;
    await sequelize.transaction(async (t) => {
        createdOrder = await PineLabsOrder.create({
            userId: userId,
            merchantOrderRef: merchantOrderRef,
            pluralOrderId: orderData.order_id,
            amount: Number(amount),
            currency: 'INR',
            callbackUrl: callbackUrl,
            failureCallbackUrl: failureCallbackUrl,
            notes: orderNotes,
            allowedPaymentMethods: orderData.allowed_payment_methods || [],
            customerId: orderData.purchase_details?.customer?.customer_id,
            customerEmail: customerEmail,
            pluralStatus: orderData.status || 'CREATED',
            preAuth: orderData.pre_auth ?? false,
            rawOrderResponse: orderData,
            ipAddress: ipAddress
        }, { transaction: t });
    });

    // Build the rebranded checkout URL
    const appUrl = process.env.APP_URL;
    const checkoutPageBase = process.env.CHECKOUT_PAGE_URL || `${appUrl}/pay`;
    const paymentUrl = `${checkoutPageBase}/${createdOrder.uuid}`;

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                orderId: createdOrder.uuid,
                merchantOrderRef: createdOrder.merchantOrderRef,
                amount: createdOrder.amount,
                currency: createdOrder.currency,
                paymentUrl: paymentUrl
            },
            "NxPay payment initialized successfully!"
        )
    );
});



