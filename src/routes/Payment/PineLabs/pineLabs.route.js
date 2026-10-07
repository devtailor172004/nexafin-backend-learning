import express from 'express';
import tokenRouter from './Token/pineLabsToken.route.js';
import orderRouter from './Order/pineLabsOrder.route.js';
import cardRouter from './Payment/Card/pineLabsCardPayment.route.js';
import upiRouter from './Payment/UPI/pineLabsUpiPayment.route.js';
import netbankingRouter from './Payment/NetBanking/pineLabsNetbankingPayment.route.js';
import { handlePineLabsPaymentCallback } from '../../../controllers/Payment/PineLabs/Callback/pineLabsCallback.controller.js';
import {
    handlePineLabsWebhook,
    handleMockPineLabsWebhook
} from '../../../controllers/Payment/PineLabs/Webhook/pineLabsWebhook.controller.js';

const router = express.Router();

router.use(tokenRouter);
router.use(orderRouter);
router.use(cardRouter);
router.use(upiRouter);
router.use(netbankingRouter);

/**
 * Pine Labs Return URL Callback
 *
 * Pine Labs customer payment complete/fail pachhi
 * aa endpoint par redirect karse.
 */
router.get(
    '/callback',
    handlePineLabsPaymentCallback
);

/**
 * Pine Labs Webhook Callback
 *
 * Production-style endpoint: the signature is ALWAYS verified.
 */
router.post(
    '/webhook',
    handlePineLabsWebhook
);

/**
 * Local development mock webhook — NO signature required.
 *
 * Deliberately separated from the real endpoint so that a missing or wrong
 * provider secret can never be silently bypassed on a live system. This route
 * is rejected with 403 when NODE_ENV=production.
 */
router.post(
    '/mock/webhook',
    handleMockPineLabsWebhook
);

export default router;
