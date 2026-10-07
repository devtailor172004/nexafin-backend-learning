/**
 * Utility functions for Pine Labs payment integration.
 */

/**
 * Normalize Pine Labs statuses to local standard values:
 * 'PROCESSED', 'AUTHORIZED', 'FAILED', 'CANCELLED', 'PENDING'
 *
 * @param {string} status - Raw status from Pine Labs
 * @returns {string} Normalized local status
 */
export const normalizePineLabsStatus = (status) => {
    if (!status) return 'PENDING';
    const upperStatus = String(status).toUpperCase();
    if (['SUCCESS', 'PROCESSED', 'CHARGED', 'CAPTURED'].includes(upperStatus)) {
        return 'PROCESSED';
    } else if (['AUTHORIZED'].includes(upperStatus)) {
        return 'AUTHORIZED';
    } else if (['FAILED', 'CANCELLED'].includes(upperStatus)) {
        return upperStatus;
    }
    return 'PENDING';
};

/**
 * Check if polling is required to determine the final payment status.
 *
 * @param {string} status - Current payment/order status
 * @param {object} responseData - Raw response from Pine Labs
 * @returns {boolean} True if polling is required
 */
export const isPineLabsPollingRequired = (status, responseData) => {
    if (!status) return false;
    const upperStatus = String(status).toUpperCase();
    const isPendingOrSuccess = ['SUCCESS', 'PROCESSING', 'PENDING'].includes(upperStatus);
    const hasPollNext = Array.isArray(responseData?.next) && responseData.next.includes('POLL');
    return isPendingOrSuccess && hasPollNext;
};

/**
 * Helper to update payment details from Pine Labs payment response item.
 *
 * @param {object} payment - PineLabsPayment Sequelize model instance
 * @param {object} pinePayment - Payment object from Pine Labs response list
 */
export const updatePaymentDetailsFromResponse = (payment, pinePayment) => {
    if (!payment || !pinePayment) return;

    if (pinePayment.acquirer_data) {
        payment.acquirer = {
            approvalCode: pinePayment.acquirer_data.approval_code || null,
            rrn: pinePayment.acquirer_data.rrn || null,
            acquirerReference: pinePayment.acquirer_data.acquirer_reference || null
        };
    }

    if (pinePayment.response_code) {
        payment.responseCode = pinePayment.response_code;
    }
    if (pinePayment.response_message) {
        payment.responseMessage = pinePayment.response_message;
    }
    if (pinePayment.transaction_id) {
        payment.transactionId = pinePayment.transaction_id;
    }
};
