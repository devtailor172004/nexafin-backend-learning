import fetch from 'node-fetch';
import { ApiError } from './ApiError.js';
import { HTTP_STATUS } from './httpStatus.js';
import { validatePanFormat } from './validationHelper.js';

/**
 * Common helper to make HTTP POST requests to the third-party verification service
 * @param {string} url - Target API URL
 * @param {Object} body - Request body payload
 * @param {string} customErrorMessage - Custom error prefix/message
 * @returns {Promise<any>} Response from the API (JSON or text)
 */
export const callVerificationApi = async (url, body, customErrorMessage = "Verification failed") => {
    if (!url) {
        throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, "Verification service URL is not configured.");
    }

    const clientId = process.env.VERIFICATION_CLIENT_ID;
    const clientSecret = process.env.VERIFICATION_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, "Verification credentials are not configured.");
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-ID': clientId,
                'X-API-KEY': clientSecret
            },
            body: JSON.stringify(body)
        });

        const contentType = response.headers.get('content-type') || '';
        let data;

        if (contentType.includes('application/json')) {
            data = await response.json();
        } else {
            const textData = await response.text();
            if (response.status !== 200 || !textData) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, `${customErrorMessage}. Empty or invalid response received.`);
            }
            return textData;
        }

        if (response.status !== 200 || !data) {
            throw new ApiError(
                HTTP_STATUS.BAD_REQUEST,
                data?.message || data?.result?.message || data?.data?.message || `${customErrorMessage}.`
            );
        }

        return data;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `${customErrorMessage}. Connection error: ${error.message}`
        );
    }
};

/**
 * Verify a PAN card details
 * @param {string} pancard - PAN Card number
 * @returns {Promise<Object>} Verification response data
 */
export const verifyPanCard = async (pancard) => {
    const cleanPan = validatePanFormat(pancard);
    const url = process.env.PAN_VERIFICATION_URL;
    const data = await callVerificationApi(url, { pan_number: cleanPan }, "PAN verification failed");

    if (data.status !== 'success') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, data.message || "PAN card is invalid.");
    }
    return data;
};

/**
 * Verify a CIN number
 * @param {string} cinNumber - CIN number
 * @returns {Promise<Object>} Verification response data
 */
export const verifyCinNumber = async (cinNumber) => {
    const url = process.env.CIN_VERIFICATION_URL;
    return await callVerificationApi(url, { id_number: cinNumber }, "CIN verification failed");
};

/**
 * Verify a GST number
 * @param {string} gstNumber - GST number
 * @returns {Promise<Object>} Verification response data
 */
export const verifyGstNumber = async (gstNumber) => {
    const url = process.env.GST_ADVANCE_VERIFICATION_URL;
    return await callVerificationApi(url, { gst_number: gstNumber }, "GST verification failed");
};

/**
 * Verify Bank Account details
 * @param {string} accountNumber - Bank Account Number
 * @param {string} ifscCode - Bank IFSC Code
 * @returns {Promise<Object>} Verification response data
 */
export const verifyBankDetails = async (accountNumber, ifscCode) => {
    const url = process.env.BANK_VERIFICATION_URL;
    const data = await callVerificationApi(
        url,
        { account_number: String(accountNumber).trim(), ifsc: String(ifscCode).trim() },
        "Bank verification failed"
    );

    const isSuccess = data.status === 'success' || data.data?.status === 'success';
    if (!isSuccess) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            data.message || data.data?.message || "Bank details verification failed."
        );
    }
    return data;
};
