/**
 * Pine Labs Plural Payment Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralizes all outbound Pine Labs Plural API calls.
 * Controllers import these helpers instead of calling `fetch` directly.
 *
 * Every function:
 *   - Accepts a plain params object
 *   - Calls the Pine Labs REST API
 *   - Parses & validates the response
 *   - Returns the parsed `data` object (or full response where applicable)
 *   - Throws ApiError on non-2xx responses or invalid JSON
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fetch from 'node-fetch';
import { ApiError } from '../../utils/ApiError.js';
import { HTTP_STATUS } from '../../utils/httpStatus.js';
import logger from '../../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the configured Pine Labs base URL or throws if missing.
 */
const getBaseUrl = () => {
    const baseUrl = process.env.PINELABS_BASE_URL;
    if (!baseUrl) {
        throw new ApiError(
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            'PINELABS_BASE_URL is not configured.'
        );
    }
    return baseUrl;
};

/**
 * Parses a Pine Labs API response text.
 * Throws ApiError on HTTP error or invalid JSON.
 *
 * @param {Response} response       - node-fetch Response object
 * @param {string}   textBody       - Raw response text
 * @param {string}   contextLabel   - Label for error messages (e.g. "Order Creation")
 * @returns {object} Parsed JSON object
 */
const parsePineLabsResponse = (response, textBody, contextLabel) => {
    let parsed;
    try {
        parsed = JSON.parse(textBody);
    } catch {
        logger.error(`Pine Labs ${contextLabel}: Invalid JSON. HTTP ${response.status}`);
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            `Invalid JSON response received from NxPay (${contextLabel}).`
        );
    }

    if (!response.ok) {
        const errorMessage =
            parsed?.message ||
            parsed?.error?.message ||
            parsed?.err_message ||
            `NxPay ${contextLabel} failed with status code ${response.status}.`;

        logger.error(`Pine Labs ${contextLabel} Failed: ${errorMessage}`, {
            statusCode: response.status,
            rawResponse: textBody
        });

        const statusCode = response.status >= 500 ? HTTP_STATUS.BAD_GATEWAY : (response.status || HTTP_STATUS.BAD_REQUEST);
        throw new ApiError(statusCode, errorMessage);
    }

    return parsed;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a payment order in the Pine Labs Plural system.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.merchantOrderRef
 * @param {number} params.orderAmount         - Amount in smallest unit (e.g. paise)
 * @param {string} [params.currency='INR']
 * @param {string} [params.notes]
 * @param {string} [params.callbackUrl]
 * @param {string} [params.failureCallbackUrl]
 * @param {object} params.customer            - { email_id, first_name, last_name, customer_id, mobile_number, country_code }
 * @returns {Promise<object>} Parsed Pine Labs order data object (data.data)
 */
export const plCreateOrder = async ({
    accessToken,
    merchantOrderRef,
    orderAmount,
    currency = 'INR',
    notes,
    callbackUrl,
    failureCallbackUrl,
    customer,
    preAuth = false
}) => {
    const baseUrl = getBaseUrl();

    const customerObj = {
        ...customer,
        customer_id: customer?.customer_id || `CUST_${Date.now()}`
    };

    const payload = {
        merchant_order_reference: merchantOrderRef,
        order_amount: { value: orderAmount, currency },
        pre_auth: preAuth,
        allowed_payment_methods: ['CARD', 'UPI', 'NETBANKING', 'WALLET'],
        notes,
        callback_url: callbackUrl,
        failure_callback_url: failureCallbackUrl,
        purchase_details: { customer: customerObj }
    };

    logger.info('Pine Labs: Creating order', { merchantOrderRef, orderAmount });

    const response = await fetch(`${baseUrl}/api/pay/v1/orders`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'Order Creation');

    const orderData = json.data;
    if (!orderData?.order_id) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'Invalid response received from NxPay order creation service.'
        );
    }

    return orderData;
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. CARD PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a raw card payment on a Pine Labs order.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.pluralOrderId
 * @param {string} params.merchantPaymentReference
 * @param {number} params.amount
 * @param {string} [params.currency='INR']
 * @param {object} params.cardDetails - { card_number, expiry_month, expiry_year, cvv, name, save }
 * @returns {Promise<object>} Parsed Pine Labs data object
 */
export const plChargeCard = async ({
    accessToken,
    pluralOrderId,
    merchantPaymentReference,
    amount,
    currency = 'INR',
    cardDetails
}) => {
    const baseUrl = getBaseUrl();

    const payload = {
        payments: [{
            merchant_payment_reference: merchantPaymentReference,
            payment_amount: { value: amount, currency },
            payment_method: 'CARD',
            payment_option: {
                card_details: {
                    card_number: cardDetails.card_number,
                    expiry_month: cardDetails.expiry_month,
                    expiry_year: cardDetails.expiry_year,
                    cvv: cardDetails.cvv,
                    name: cardDetails.name,
                    save: cardDetails.save !== undefined ? cardDetails.save : true
                }
            }
        }]
    };

    logger.info(`Pine Labs: Charging card for order ${pluralOrderId}`, {
        merchantPaymentReference
    });

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}/payments`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'Card Payment');

    const data = json.data;
    if (!data) {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response structure received from NxPay (Card Payment).'
        );
    }

    return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. CARD DETAILS LOOKUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves card details (network, issuer, native OTP support) from Pine Labs.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.cardNumber  - At least first 6 digits (BIN)
 * @param {number} params.amount
 * @returns {Promise<object>} Full parsed Pine Labs response (no .data wrapper)
 */
export const plGetCardDetails = async ({ accessToken, cardNumber, amount }) => {
    const baseUrl = getBaseUrl();

    const response = await fetch(`${baseUrl}/api/pay/v1/getCardDetails`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount: String(amount),
            card_details: [{
                payment_identifier: cardNumber,
                payment_reference_type: 'CARD'
            }]
        })
    });

    const text = await response.text();
    return parsePineLabsResponse(response, text, 'Card Details');
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. OTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an OTP for a Pine Labs card payment.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.nxPayPaymentId
 * @returns {Promise<object>} Full parsed Pine Labs response
 */
export const plGenerateOtp = async ({ accessToken, nxPayPaymentId }) => {
    const baseUrl = getBaseUrl();

    const response = await fetch(`${baseUrl}/api/pay/v1/otp/generate`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ payment_id: nxPayPaymentId })
    });

    const text = await response.text();
    return parsePineLabsResponse(response, text, 'OTP Generation');
};

/**
 * Resends an OTP for a Pine Labs card payment.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.nxPayPaymentId
 * @returns {Promise<object>} Full parsed Pine Labs response
 */
export const plResendOtp = async ({ accessToken, nxPayPaymentId }) => {
    const baseUrl = getBaseUrl();

    const response = await fetch(`${baseUrl}/api/pay/v1/otp/resend`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ payment_id: nxPayPaymentId })
    });

    const text = await response.text();
    return parsePineLabsResponse(response, text, 'OTP Resend');
};

/**
 * Submits an OTP to verify a Pine Labs card payment.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.nxPayPaymentId
 * @param {string} params.otp
 * @returns {Promise<object>} Parsed Pine Labs data object
 */
export const plSubmitOtp = async ({
    accessToken,
    nxPayPaymentId,
    otp
}) => {
    const baseUrl = getBaseUrl();


    if (!accessToken) {
        throw new ApiError(
            HTTP_STATUS.UNAUTHORIZED,
            'NxPay access token is required.'
        );
    }


    if (!nxPayPaymentId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'NxPay payment ID is required.'
        );
    }


    if (!otp || String(otp).trim().length === 0) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'OTP is required.'
        );
    }


    const response = await fetch(
        `${baseUrl}/api/pay/v1/otp/submit`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                payment_id: nxPayPaymentId,
                otp: String(otp).trim()
            })
        }
    );


    const text = await response.text();


    // This function should throw an error automatically
    // when Pine Labs returns a non-success response.
    const json = parsePineLabsResponse(
        response,
        text,
        'OTP Submit'
    );


    // Pine Labs response can be:
    //
    // {
    //   "data": { ... }
    // }
    //
    // OR directly:
    //
    // {
    //   "status": "PROCESSED"
    // }
    //
    // So support both structures.
    const data = json?.data ?? json;


    if (!data || typeof data !== 'object') {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response received from NxPay (OTP Submit).'
        );
    }


    return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. CARD AUTHORIZE (Apple Pay / Decoupled Auth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs decoupled authorization (e.g. Apple Pay) for a Pine Labs payment.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.pluralOrderId
 * @param {string} params.nxPayPaymentId
 * @param {object} params.decryptedCardDetails
 * @param {string} params.authenticationType
 * @param {object} [params.acquirerPaymentDetails]
 * @returns {Promise<object>} Parsed Pine Labs data object
 */
export const plAuthorizePayment = async ({
    accessToken,
    pluralOrderId,
    nxPayPaymentId,
    decryptedCardDetails,
    authenticationType,
    acquirerPaymentDetails
}) => {
    const baseUrl = getBaseUrl();

    const {
        pan, cvv, card_holder_name, token,
        expiration_month, expiration_year,
        cryptogram, cavv, eci
    } = decryptedCardDetails;

    const requestBody = {
        decrypted_card_details: {
            pan,
            cvv,
            ...(card_holder_name && { card_holder_name }),
            ...(token && { token }),
            expiration_month,
            expiration_year,
            cryptogram,
            ...(cavv && { cavv }),
            ...(eci && { eci })
        },
        authentication_type: authenticationType,
        ...(acquirerPaymentDetails && typeof acquirerPaymentDetails === 'object' && {
            acquirer_payment_details: acquirerPaymentDetails
        })
    };

    logger.info(
        `Pine Labs: Authorizing payment ${nxPayPaymentId} for order ${pluralOrderId}`
    );

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}/payments/${nxPayPaymentId}/authorize`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'Payment Authorization');

    const data = json.data;
    if (!data) {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response structure received from NxPay (Authorization).'
        );
    }

    return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. UPI PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a UPI Intent payment (with optional QR code) on a Pine Labs order.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.pluralOrderId
 * @param {string} params.merchantPaymentReference
 * @param {number} params.amount
 * @param {string} [params.currency='INR']
 * @param {boolean} [params.useQr=false]
 * @returns {Promise<object>} Parsed Pine Labs data object
 */
export const plCreateUpiPayment = async ({
    accessToken,
    pluralOrderId,
    merchantPaymentReference,
    amount,
    currency = 'INR',
    useQr = false
}) => {
    const baseUrl = getBaseUrl();

    const upiDetails = { txn_mode: 'INTENT' };
    if (useQr) upiDetails.qr_code = true;

    const payload = {
        payments: [{
            merchant_payment_reference: merchantPaymentReference,
            payment_amount: { value: amount, currency },
            payment_method: 'UPI',
            payment_option: { upi_details: upiDetails }
        }]
    };

    logger.info(`Pine Labs: Creating UPI payment for order ${pluralOrderId}`, {
        merchantPaymentReference, amount, useQr
    });

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}/payments`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'UPI Payment');

    const data = json.data;
    if (!data) {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response structure received from NxPay (UPI Payment).'
        );
    }

    return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. NETBANKING PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a NetBanking payment on a Pine Labs order.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.pluralOrderId
 * @param {string} params.merchantPaymentReference
 * @param {number} params.amount
 * @param {string} [params.currency='INR']
 * @param {string} params.payCode              - Bank pay code e.g. 'NB1531'
 * @param {string} [params.userAgent='']       - Browser user-agent
 * @returns {Promise<object>} Parsed Pine Labs data object
 */
export const plCreateNetbankingPayment = async ({
    accessToken,
    pluralOrderId,
    merchantPaymentReference,
    amount,
    currency = 'INR',
    payCode,
    userAgent = ''
}) => {
    const baseUrl = getBaseUrl();

    const payload = {
        payments: [{
            merchant_payment_reference: merchantPaymentReference,
            payment_amount: { value: amount, currency },
            payment_method: 'NETBANKING',
            payment_option: {
                netbanking_details: { pay_code: payCode }
            },
            device_info: {
                device_type: 'WEB',
                browser_user_agent: userAgent
            }
        }]
    };

    logger.info(`Pine Labs: Creating NetBanking payment for order ${pluralOrderId}`, {
        merchantPaymentReference, amount, payCode
    });

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}/payments`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'NetBanking Payment');

    const data = json.data;
    if (!data) {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response structure received from NxPay (NetBanking Payment).'
        );
    }

    return data;
};

/**
 * Captures a pre-authorized payment in the Pine Labs Plural system.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.pluralOrderId
 * @param {string} params.merchantCaptureReference
 * @param {number} params.captureAmount
 * @param {string} [params.currency='INR']
 * @returns {Promise<object>} Parsed Pine Labs response data object
 */
export const plCaptureAuthorizedOrder = async ({
    accessToken,
    pluralOrderId,
    merchantCaptureReference,
    captureAmount,
    currency = 'INR'
}) => {
    const baseUrl = getBaseUrl();

    const payload = {
        merchant_capture_reference: merchantCaptureReference,
        capture_amount: {
            value: Number(captureAmount),
            currency
        }
    };

    logger.info(`Pine Labs: Capturing order ${pluralOrderId}`, {
        merchantCaptureReference,
        captureAmount,
        currency
    });

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}/capture`,
        {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'Order Capture');

    const data = json.data;
    if (!data) {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response structure received from NxPay (Order Capture).'
        );
    }

    return data;
};


/**
 * Cancel a pre-authorized Pine Labs payment order
 *
 * @param {object} params Parameter object
 * @param {string} params.accessToken Active JWT access token
 * @param {string} params.pluralOrderId Pine Labs plural order ID (v1-...)
 * @returns {Promise<object>} Parsed Pine Labs response data object
 */
export const plCancelAuthorizedOrder = async ({
    accessToken,
    pluralOrderId
}) => {
    const baseUrl = getBaseUrl();

    logger.info(`Pine Labs: Cancelling pre-authorized order ${pluralOrderId}`);

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}/cancel`,
        {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'Order Cancel');

    const data = json.data;
    if (!data) {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response structure received from NxPay (Order Cancel).'
        );
    }

    return data;
};


/**
 * Retrieves the details and status of an order from Pine Labs.
 *
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.pluralOrderId
 * @returns {Promise<object>} Parsed Pine Labs response data object
 */
export const plGetOrderDetails = async ({ accessToken, pluralOrderId }) => {
    const baseUrl = getBaseUrl();

    if (!accessToken) {
        throw new ApiError(
            HTTP_STATUS.UNAUTHORIZED,
            'NxPay access token is required.'
        );
    }

    if (!pluralOrderId) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'NxPay order ID is required.'
        );
    }

    const response = await fetch(
        `${baseUrl}/api/pay/v1/orders/${pluralOrderId}`,
        {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    const text = await response.text();
    const json = parsePineLabsResponse(response, text, 'Get Order Details');

    const data = json?.data ?? json;
    if (!data || typeof data !== 'object') {
        throw new ApiError(
            HTTP_STATUS.BAD_GATEWAY,
            'Invalid response received from NxPay (Get Order Details).'
        );
    }

    return data;
};




