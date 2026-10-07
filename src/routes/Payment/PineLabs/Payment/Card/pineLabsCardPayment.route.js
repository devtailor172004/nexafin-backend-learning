import express from 'express';
import {
    chargeCardPayment,
    generatePineLabsOtp,
    resendPineLabsOtp,
    submitPineLabsOtp,
    getPineLabsCardDetails,
    authorizePineLabsPayment,
    getPineLabsPaymentStatus
} from '../../../../../controllers/Payment/PineLabs/Payment/Card/pineLabsCardPayment.controller.js';
import { verifyToken, parseToken } from '../../../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to check card network/type details in Pine Labs Plural
router.post('/card-details', parseToken, getPineLabsCardDetails);

// Route to charge a card payment for a Pine Labs order
router.post('/order/:orderId/payments', parseToken, chargeCardPayment);

// Route for Decoupled Authorization for Apple Pay
router.post('/payments/:paymentId/authorize', parseToken, authorizePineLabsPayment);

// Routes for Pine Labs native OTP flow
router.post('/payments/:paymentId/otp/generate', parseToken, generatePineLabsOtp);
router.post('/payments/:paymentId/otp/resend', parseToken, resendPineLabsOtp);
router.post('/payments/:paymentId/otp/submit', parseToken, submitPineLabsOtp);

// Route to get payment status (manually poll or query status)
router.get('/payments/:paymentId/status', parseToken, getPineLabsPaymentStatus);

export default router;
