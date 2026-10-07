import express from 'express';
import { createPineLabsUpiIntentPayment } from '../../../../../controllers/Payment/PineLabs/Payment/UPI/pineLabsUpiPayment.controller.js';
import { verifyToken, parseToken } from '../../../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to initiate UPI Intent payment for a Pine Labs order
router.post('/order/:orderId/upi/payments', parseToken, createPineLabsUpiIntentPayment);

export default router;
