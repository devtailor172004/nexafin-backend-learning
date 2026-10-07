import express from 'express';
import { createPineLabsNetbankingPayment } from '../../../../../controllers/Payment/PineLabs/Payment/Netbanking/pineLabsNetbankingPayment.controller.js';
import { verifyToken, parseToken } from '../../../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to initiate a NetBanking payment for a Pine Labs order
router.post('/order/:orderId/netbanking/payments', parseToken, createPineLabsNetbankingPayment);

export default router;
