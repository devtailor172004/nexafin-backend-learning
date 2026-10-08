import dotenv from 'dotenv';
dotenv.config();

/**
 * End-to-end payment proof (run against a live server).
 *
 *   node scripts/sandboxE2E.js
 *
 * Exercises the real pipeline with no shortcuts:
 *   login -> provider token -> create order -> create UPI payment
 *         -> sandbox fires a SIGNED webhook -> state machine applies it
 *         -> ops API reflects the settlement in real time
 *
 * Requires: PINELABS_BASE_URL pointing at the sandbox, PAYMENT_SANDBOX_ENABLED
 * not 'false', and a seeded admin (scripts/dbSetup.js --seed).
 */

const BASE = (process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
const EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@securepay.local';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';

let passed = 0;
let failed = 0;

const check = (name, condition, detail = '') => {
    if (condition) {
        passed += 1;
        console.log(`  \u2713 ${name}`);
    } else {
        failed += 1;
        console.error(`  \u2717 ${name}${detail ? ` -> ${detail}` : ''}`);
    }
};

const request = async (method, path, { body, token, idempotencyKey } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: response.status, json, text };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const uniqueKey = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createOrder = (token, { amount, notes }) => request('POST', '/api/payment/nxpay/order', {
    token,
    idempotencyKey: uniqueKey('order'),
    body: {
        amount,
        notes,
        callbackUrl: `${BASE}/onboarding/success`,
        failureCallbackUrl: `${BASE}/onboarding/success`,
        purchase_details: {
            customer: {
                customer_id: 'CUST_SANDBOX',
                email_id: 'buyer@example.com',
                first_name: 'Sandbox',
                last_name: 'Buyer',
                mobile_number: '9876543210',
                country_code: '91'
            }
        }
    }
});

const createUpi = (token, orderUuid) => request('POST', `/api/payment/nxpay/order/${orderUuid}/upi/payments`, {
    token,
    idempotencyKey: uniqueKey('upi'),
    body: { useQr: false }
});

const createNetbanking = (token, orderUuid) => request('POST', `/api/payment/nxpay/order/${orderUuid}/netbanking/payments`, {
    token,
    idempotencyKey: uniqueKey('nb'),
    body: { payCode: 'NB1531' }
});

const createCard = (token, orderUuid) => request('POST', `/api/payment/nxpay/order/${orderUuid}/payments`, {
    token,
    body: {
        payments: [{
            payment_option: {
                card_details: {
                    card_number: '4012 0000 0000 0001',
                    expiry_month: '12',
                    expiry_year: '2030',
                    cvv: '123',
                    name: 'Sandbox Tester',
                    save: false
                }
            }
        }]
    }
});

const run = async () => {
    console.log(`Sandbox E2E against ${BASE}\n`);

    console.log('1. Authenticate + obtain provider token');
    const login = await request('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    check('admin login returns a JWT', login.status === 200 && Boolean(login.json?.data?.token), `status=${login.status} ${login.text.slice(0, 200)}`);
    const token = login.json?.data?.token;
    if (!token) throw new Error('Cannot continue without an admin token.');

    const providerToken = await request('POST', '/api/payment/nxpay/token', {
        token,
        body: { clientId: 'sandbox_client', clientSecret: 'sandbox_secret' }
    });
    check('provider token cached', providerToken.status === 200 && Boolean(providerToken.json?.data?.access_token), `status=${providerToken.status} ${providerToken.text.slice(0, 200)}`);

    console.log('\n2. Happy-path payment (UPI)');
    const order = await createOrder(token, { amount: 100, notes: 'Sandbox happy path' });
    check('order created via provider', order.status === 200 && Boolean(order.json?.data?.uuid), `status=${order.status} ${order.text.slice(0, 200)}`);
    const orderUuid = order.json?.data?.uuid;

    const payment = await createUpi(token, orderUuid);
    check('UPI payment created', payment.status === 200 && Boolean(payment.json?.data?.paymentId), `status=${payment.status} ${payment.text.slice(0, 300)}`);
    const paymentUuid = payment.json?.data?.paymentId;

    console.log('   waiting for the signed provider webhook...');
    await sleep(3000);

    const timeline = await request('GET', `/api/securepay/payments/${paymentUuid}/timeline`, { token });
    const events = timeline.json?.data?.timeline || [];
    check('payment settled as PROCESSED by webhook', timeline.json?.data?.status === 'PROCESSED', `status=${timeline.json?.data?.status}`);
    check('webhook was recorded on the timeline', events.some((e) => e.source === 'WEBHOOK'), `events=${events.map((e) => e.event).join(',')}`);
    check('state transition PROCESSED recorded', events.some((e) => e.to === 'PROCESSED'), `events=${events.map((e) => `${e.from}->${e.to}`).join(',')}`);

    console.log('\n3. Failure-path payment (amount ending .13 is declined by the sandbox)');
    const failOrder = await createOrder(token, { amount: 1.13, notes: 'Sandbox failure path' });
    check('failure-path order created', failOrder.status === 200 && Boolean(failOrder.json?.data?.uuid), `status=${failOrder.status} ${failOrder.text.slice(0, 300)}`);
    const failUuid = failOrder.json?.data?.uuid;
    const failPayment = await createUpi(token, failUuid);
    check('failure-path UPI payment created', failPayment.status === 200 && Boolean(failPayment.json?.data?.paymentId), `status=${failPayment.status} ${failPayment.text.slice(0, 300)}`);
    const failPaymentUuid = failPayment.json?.data?.paymentId;
    await sleep(3000);

    const failTimeline = await request('GET', `/api/securepay/payments/${failPaymentUuid}/timeline`, { token });
    check('declined payment ended FAILED', failTimeline.json?.data?.status === 'FAILED', `status=${failTimeline.json?.data?.status}`);

    console.log('\n4. Operations dashboard reflects real data');
    const dashboard = await request('GET', '/api/securepay/dashboard', { token });
    const payments = dashboard.json?.data?.payments || {};
    check('dashboard counts a succeeded payment', (payments.succeeded || 0) >= 1, `succeeded=${payments.succeeded}`);
    check('dashboard counts a failed payment', (payments.failed || 0) >= 1, `failed=${payments.failed}`);
    check('success rate computed', typeof payments.successRate === 'number', `successRate=${payments.successRate}`);

    console.log('\n5. Idempotent replay is safe');
    const key = uniqueKey('replay');
    const first = await request('POST', '/api/payment/nxpay/order', {
        token,
        idempotencyKey: key,
        body: { amount: 55, callbackUrl: `${BASE}/onboarding/success`, failureCallbackUrl: `${BASE}/onboarding/success`, purchase_details: { customer: { email_id: 'a@b.c', first_name: 'A', last_name: 'B', mobile_number: '9876500000' } } }
    });
    const second = await request('POST', '/api/payment/nxpay/order', {
        token,
        idempotencyKey: key,
        body: { amount: 55, callbackUrl: `${BASE}/onboarding/success`, failureCallbackUrl: `${BASE}/onboarding/success`, purchase_details: { customer: { email_id: 'a@b.c', first_name: 'A', last_name: 'B', mobile_number: '9876500000' } } }
    });
    check('same Idempotency-Key replays the same order', first.json?.data?.uuid && first.json.data.uuid === second.json?.data?.uuid, `first=${first.json?.data?.uuid} second=${second.json?.data?.uuid}`);

    console.log('\n5b. Other payment methods used by the simulator');
    const nbOrder = await createOrder(token, { amount: 75, notes: 'Sandbox netbanking' });
    const nb = await createNetbanking(token, nbOrder.json?.data?.uuid);
    check('NetBanking payment created', nb.status === 200 && Boolean(nb.json?.data?.paymentId), `status=${nb.status} ${nb.text.slice(0, 250)}`);

    const cardOrder = await createOrder(token, { amount: 300, notes: 'Sandbox card' });
    const card = await createCard(token, cardOrder.json?.data?.uuid);
    check('Card payment created', card.status === 200 && Boolean(card.json?.data?.paymentId), `status=${card.status} ${card.text.slice(0, 250)}`);

    await sleep(3000);
    const nbTimeline = await request('GET', `/api/securepay/payments/${nb.json?.data?.paymentId}/timeline`, { token });
    check('NetBanking settled as PROCESSED', nbTimeline.json?.data?.status === 'PROCESSED', `status=${nbTimeline.json?.data?.status}`);
    const cardTimeline = await request('GET', `/api/securepay/payments/${card.json?.data?.paymentId}/timeline`, { token });
    check('Card settled as PROCESSED', cardTimeline.json?.data?.status === 'PROCESSED', `status=${cardTimeline.json?.data?.status}`);

    console.log('\n6. Settlement lifecycle');
    const settleRun = await request('POST', '/api/securepay/settlements/run', { token, body: {} });
    check('settlement run settles captured payments', settleRun.status === 200 && (settleRun.json?.data?.settledCount || 0) >= 1, `status=${settleRun.status} ${settleRun.text.slice(0, 200)}`);
    const settleSummary = await request('GET', '/api/securepay/settlements/summary', { token });
    check('settlement summary reports settled funds', (settleSummary.json?.data?.settled?.count || 0) >= 1, `settled=${JSON.stringify(settleSummary.json?.data?.settled)}`);

    console.log('\n7. KYC journey');
    const adminUuid = login.json?.data?.user?.uuid;
    const journey = await request('GET', `/api/admin/kyc/${adminUuid}/journey`, { token });
    check('KYC journey returns ordered steps', journey.status === 200 && Array.isArray(journey.json?.data?.steps) && journey.json.data.steps.length >= 5, `status=${journey.status} steps=${journey.json?.data?.steps?.length}`);
    check('KYC journey computes completion', typeof journey.json?.data?.completionPercent === 'number', `completion=${journey.json?.data?.completionPercent}`);

    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
};

run().catch((error) => {
    console.error('\nE2E crashed:', error.message);
    process.exit(1);
});
