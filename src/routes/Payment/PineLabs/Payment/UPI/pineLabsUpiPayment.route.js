import express from 'express';
import { createPineLabsUpiIntentPayment } from '../../../../../controllers/Payment/PineLabs/Payment/UPI/pineLabsUpiPayment.controller.js';
import { verifyToken } from '../../../../../middlewares/authMiddleware.js';

const router = express.Router();

router.post(
    '/order/:orderId/upi/payments',
    verifyToken,
    createPineLabsUpiIntentPayment
);

export default router;
