import express from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';

/**
 * Pine Labs Plural-compatible SANDBOX gateway.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a drop-in provider, not a code path inside the payment controllers.
 * It speaks the same REST contract as Pine Labs Plural:
 *
 *   POST /api/auth/v1/token
 *   POST /api/pay/v1/orders
 *   GET  /api/pay/v1/orders/:orderId
 *   POST /api/pay/v1/orders/:orderId/payments
 *   POST /api/pay/v1/orders/:orderId/payments/:paymentId/authorize
 *   PUT  /api/pay/v1/orders/:orderId/capture
 *   PUT  /api/pay/v1/orders/:orderId/cancel
 *   POST /api/pay/v1/getCardDetails
 *   POST /api/pay/v1/otp/generate | resend | submit
 *
 * The whole existing pipeline (auth middleware -> idempotency -> controllers ->
 * pinelabs.service -> state machine -> webhook ledger -> live SSE events) runs
 * UNCHANGED; it simply points at this gateway by setting
 *
 *   PINELABS_BASE_URL=http://127.0.0.1:<PORT>/sandbox/pinelabs
 *
 * After a payment is created the gateway asynchronously POSTs a signed webhook
 * back to the app, exactly like a real provider, so settlement/capture/refund
 * state is driven by webhook delivery rather than being hard-coded.
 *
 * ── Sandbox outcome rules (deterministic) ────────────────────────────────────
 *   • order notes containing "FAIL"            -> FAILED
 *   • amount (paise) ending in 13 (₹x.13)      -> FAILED
 *   • card number ending 0002                  -> FAILED
 *   • anything else                            -> PROCESSED
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Ensure webhook signatures can be verified even when no real secret is set.
// In production PINE_LABS_CLIENT_SECRET must be a real value.
if (!process.env.PINE_LABS_CLIENT_SECRET) {
    process.env.PINE_LABS_CLIENT_SECRET = 'whsec_sandbox_secret';
    logger.warn('[Sandbox] PINE_LABS_CLIENT_SECRET was not set — using the sandbox default so signed webhooks verify. Set a real value outside development.');
}

const router = express.Router();

const sandboxEnabled = () => (
    process.env.PAYMENT_SANDBOX_ENABLED === 'true'
    || (process.env.PAYMENT_SANDBOX_ENABLED !== 'false' && process.env.NODE_ENV !== 'production')
);

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const hexId = () => crypto.randomUUID().replace(/-/g, '');

const appBaseUrl = () => (
    process.env.SANDBOX_APP_URL
    || `http://127.0.0.1:${process.env.PORT || 3000}`
);

const webhookUrl = () => (
    process.env.SANDBOX_WEBHOOK_URL
    || `${appBaseUrl()}/api/payment/nxpay/webhook`
);

const webhookSecret = () => process.env.PINE_LABS_CLIENT_SECRET || 'whsec_sandbox_secret';

const signWebhook = (webhookId, timestamp, rawBody) => crypto
    .createHmac('sha256', webhookSecret())
    .update(`${webhookId}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');

// Provider-side in-memory state (the sandbox is intentionally stateless across
// restarts; the app's own database is the source of truth).
const orders = new Map();
const payments = new Map();

const decideOutcome = ({ notes, amountPaise, cardNumber }) => {
    if (notes && String(notes).toUpperCase().includes('FAIL')) return 'FAILED';
    if (cardNumber && String(cardNumber).replace(/\s+/g, '').endsWith('0002')) return 'FAILED';
    if (amountPaise !== undefined && amountPaise !== null && Number(amountPaise) % 100 === 13) return 'FAILED';
    return 'PROCESSED';
};

/**
 * Delivers a signed webhook to the application, mirroring Pine Labs headers.
 */
const dispatchWebhook = async (order, payment, outcome) => {
    const webhookId = newId('wh');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const eventType = outcome === 'FAILED' ? 'PAYMENT_FAILED' : 'PAYMENT_PROCESSED';

    const body = JSON.stringify({
        event_type: eventType,
        data: {
            order_id: order.order_id,
            merchant_order_reference: order.merchant_order_reference,
            status: outcome,
            payments: [{
                id: payment.id,
                merchant_payment_reference: payment.merchant_payment_reference,
                status: outcome,
                payment_method: payment.payment_method,
                payment_amount: payment.payment_amount,
                acquirer_data: payment.acquirer_data,
                error_code: payment.error_code || null,
                error_message: payment.error_message || null
            }]
        }
    });

    const signature = signWebhook(webhookId, timestamp, body);

    try {
        const response = await fetch(webhookUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'webhook-id': webhookId,
                'webhook-timestamp': timestamp,
                'webhook-signature': `v1,${signature}`
            },
            body
        });
        logger.info(`[Sandbox] Webhook ${eventType} for ${payment.id} -> ${response.status}`);
    } catch (error) {
        logger.error(`[Sandbox] Webhook delivery failed: ${error.message}`);
    }
};

const finalizeLater = (order, payment, outcome) => {
    const delayMs = Number(process.env.SANDBOX_WEBHOOK_DELAY_MS || 600);
    setTimeout(() => {
        payment.status = outcome;
        order.status = outcome;
        if (outcome === 'FAILED') {
            payment.error_code = 'SANDBOX_DECLINED';
            payment.error_message = 'Declined by a sandbox outcome rule (see sandbox rules).';
        }
        dispatchWebhook(order, payment, outcome).catch(() => { /* already logged */ });
    }, delayMs).unref?.();
};

// ─── AUTH ────────────────────────────────────────────────────────────────────
router.post('/api/auth/v1/token', (req, res) => {
    const { client_id, client_secret } = req.body || {};
    if (!client_id || !client_secret) {
        return res.status(401).json({ message: 'client_id and client_secret are required.' });
    }
    return res.json({
        access_token: `sandbox_${crypto.randomBytes(20).toString('hex')}`,
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────
router.post('/api/pay/v1/orders', (req, res) => {
    const b = req.body || {};
    const amountPaise = b.order_amount?.value;
    const orderId = `v1-${crypto.randomBytes(10).toString('hex')}`;

    const order = {
        order_id: orderId,
        merchant_order_reference: b.merchant_order_reference || null,
        status: 'CREATED',
        pre_auth: Boolean(b.pre_auth),
        allowed_payment_methods: b.allowed_payment_methods || ['CARD', 'UPI', 'NETBANKING'],
        purchase_details: b.purchase_details || {},
        order_amount: b.order_amount || null,
        notes: b.notes || null,
        payments: [],
        forcedOutcome: decideOutcome({ notes: b.notes, amountPaise })
    };

    orders.set(orderId, order);
    logger.info(`[Sandbox] Order ${orderId} created (forced outcome: ${order.forcedOutcome}).`);
    return res.json({ status: 'CREATED', data: order });
});

router.get('/api/pay/v1/orders/:orderId', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    return res.json({ status: order.status, data: order });
});

router.put('/api/pay/v1/orders/:orderId/capture', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    order.status = 'PROCESSED';
    order.merchant_capture_reference = req.body?.merchant_capture_reference || null;
    return res.json({ status: 'PROCESSED', data: order });
});

router.put('/api/pay/v1/orders/:orderId/cancel', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    order.status = 'CANCELLED';
    return res.json({ status: 'CANCELLED', data: order });
});

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
router.post('/api/pay/v1/orders/:orderId/payments', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    const requested = req.body?.payments?.[0] || {};
    const paymentId = newId('pay');
    const method = requested.payment_method || 'CARD';

    const cardNumber =
        requested.payment_option?.card_details?.card_number
        || requested.payment_option?.card_details?.pan
        || null;

    const outcome = decideOutcome({
        notes: order.notes,
        amountPaise: requested.payment_amount?.value,
        cardNumber
    }) === 'FAILED' || order.forcedOutcome === 'FAILED'
        ? 'FAILED'
        : 'PROCESSED';

    const payment = {
        id: paymentId,
        merchant_payment_reference: requested.merchant_payment_reference || newId('mpr'),
        status: 'PENDING',
        payment_method: method,
        payment_amount: requested.payment_amount,
        payment_option: requested.payment_option || {},
        challenge_url: method === 'UPI'
            ? `upi://pay?pa=sandbox@upi&pn=SecurePay%20Sandbox&tr=${paymentId}`
            : undefined,
        acquirer_data: {
            approval_code: hexId().slice(0, 6).toUpperCase(),
            rrn: String(Date.now()).slice(-12),
            acquirer_reference: paymentId.toUpperCase()
        }
    };

    order.payments.push(payment);
    order.status = 'PENDING';
    payments.set(paymentId, payment);

    finalizeLater(order, payment, outcome);

    logger.info(`[Sandbox] Payment ${paymentId} (${method}) accepted, will settle as ${outcome}.`);

    return res.json({
        status: 'PENDING',
        data: {
            order_id: order.order_id,
            status: order.status,
            challenge_url: payment.challenge_url || null,
            payments: [payment]
        }
    });
});

router.post('/api/pay/v1/orders/:orderId/payments/:paymentId/authorize', (req, res) => {
    const order = orders.get(req.params.orderId);
    const payment = payments.get(req.params.paymentId);
    if (!order || !payment) return res.status(404).json({ message: 'Order or payment not found.' });
    payment.status = 'AUTHORIZED';
    return res.json({ status: 'AUTHORIZED', data: { order_id: order.order_id, payments: [payment] } });
});

// ─── CARD DETAILS + OTP ──────────────────────────────────────────────────────
router.post('/api/pay/v1/getCardDetails', (req, res) => {
    const identifier = req.body?.card_details?.[0]?.payment_identifier || '';
    const bin = String(identifier).replace(/\s+/g, '');
    const network = bin.startsWith('4') ? 'VISA'
        : bin.startsWith('5') ? 'MASTERCARD'
        : bin.startsWith('3') ? 'AMEX'
        : bin.startsWith('6') ? 'RUPAY'
        : 'UNKNOWN';

    return res.json({
        status: 'SUCCESS',
        data: {
            card_details: [{
                payment_identifier: identifier,
                card_network: network,
                native_otp_supported: true,
                is_valid: bin.length >= 6
            }]
        }
    });
});

router.post('/api/pay/v1/otp/generate', (req, res) => res.json({
    status: 'SUCCESS',
    data: { payment_id: req.body?.payment_id || null, otp_length: 6, message: 'Use OTP 123456 in the sandbox.' }
}));

router.post('/api/pay/v1/otp/resend', (req, res) => res.json({
    status: 'SUCCESS',
    data: { payment_id: req.body?.payment_id || null, message: 'OTP resent (sandbox: 123456).' }
}));

router.post('/api/pay/v1/otp/submit', (req, res) => {
    const paymentId = req.body?.payment_id;
    const otp = String(req.body?.otp || '').trim();

    // Sandbox rule: OTP 123456 succeeds, anything else fails.
    if (otp !== '123456') {
        return res.json({ status: 'FAILED', data: { payment_id: paymentId, status: 'FAILED', error_code: 'INVALID_OTP' } });
    }
    return res.json({ status: 'PROCESSED', data: { payment_id: paymentId, status: 'PROCESSED' } });
});

export { sandboxEnabled };
export default router;
