import express from 'express';
import { createPaymentOrder, capturePineLabsAuthorizedOrder, cancelPineLabsOrder, getPineLabsOrderDetails, initiatePayment } from '../../../../controllers/Payment/PineLabs/Order/pineLabsOrder.controller.js';
import { verifyToken, parseToken } from '../../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to initiate a rebranded payment checkout session
router.post('/initiate', verifyToken, initiatePayment);

// Route to initialize a payment order in Pine Labs
router.post('/order', verifyToken, createPaymentOrder);

// Route to get details of a Pine Labs payment order
router.get('/orders/:orderId', parseToken, getPineLabsOrderDetails);

// Route to capture a pre-authorized Pine Labs payment order
router.put('/orders/:orderId/capture', verifyToken, capturePineLabsAuthorizedOrder);

// Route to cancel a pre-authorized Pine Labs payment order
router.put('/orders/:orderId/cancel', verifyToken, cancelPineLabsOrder);

export default router;

