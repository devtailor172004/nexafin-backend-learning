import { useState } from 'react';
import { endpoints, newIdempotencyKey } from '../lib/api.js';
import { Badge, Button, Card, ErrorNotice, Field, Select, TextInput } from '../components/ui.jsx';
import { formatCurrency, formatDateTime } from '../lib/format.js';

/**
 * Payment Simulator — the one place in the console that WRITES.
 *
 * It calls the same public merchant endpoints the real checkout uses:
 *   POST /api/payment/nxpay/token
 *   POST /api/payment/nxpay/order            (Idempotency-Key required)
 *   POST /api/payment/nxpay/order/:id/{upi,netbanking}/payments
 *   POST /api/payment/nxpay/order/:id/payments            (card)
 *
 * Nothing is faked on the server: an order + payment row are written to the
 * hosted database, the provider fires a SIGNED webhook back, and the state
 * machine moves the payment. This page only drives it.
 */

const METHODS = [
    { value: 'UPI', label: 'UPI (intent)' },
    { value: 'NETBANKING', label: 'NetBanking' },
    { value: 'CARD', label: 'Card' }
];

const DEFAULT_CARD = {
    card_number: '4012 0000 0000 0001',
    expiry_month: '12',
    expiry_year: '2030',
    cvv: '123',
    name: 'Sandbox Tester',
    save: false
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TONE = {
    info: 'text-slate-300',
    ok: 'text-emerald-300',
    bad: 'text-rose-300'
};

export default function Simulator() {
    const [amount, setAmount] = useState('250');
    const [method, setMethod] = useState('UPI');
    const [outcome, setOutcome] = useState('PROCESSED');
    const [payCode, setPayCode] = useState('NB1531');
    const [card, setCard] = useState(DEFAULT_CARD);
    const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey('sim-order'));
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const [steps, setSteps] = useState([]);
    const [result, setResult] = useState(null);

    const log = (label, detail, tone = 'info') => setSteps((prev) => [...prev, { label, detail, tone }]);

    const run = async () => {
        setRunning(true);
        setError(null);
        setSteps([]);
        setResult(null);

        try {
            const value = Number(amount);
            if (!Number.isFinite(value) || value <= 0) {
                throw new Error('Enter an amount greater than 0.');
            }

            log('1. Provider token', 'POST /api/payment/nxpay/token');
            await endpoints.providerToken('sandbox_client', 'sandbox_secret');
            log('↳ token cached', 'Ready to call the provider', 'ok');

            log('2. Create order', 'POST /api/payment/nxpay/order (Idempotency-Key sent)');
            const order = await endpoints.createOrder({
                amount: value,
                notes: outcome === 'FAILED' ? 'SANDBOX FAIL TEST' : 'Simulator payment',
                callbackUrl: `${window.location.origin}/onboarding/success`,
                failureCallbackUrl: `${window.location.origin}/onboarding/success`,
                purchase_details: {
                    customer: {
                        customer_id: 'CUST_SIMULATOR',
                        email_id: 'simulator@securepay.local',
                        first_name: 'Simulator',
                        last_name: 'Buyer',
                        mobile_number: '9876500001',
                        country_code: '91'
                    }
                }
            }, idempotencyKey);
            const orderUuid = order.data?.uuid;
            if (!orderUuid) throw new Error('Order was not created.');
            log('↳ order created', `uuid ${orderUuid}`, 'ok');

            let payment;
            if (method === 'UPI') {
                log('3. Create UPI payment', `POST /api/payment/nxpay/order/${orderUuid}/upi/payments`);
                payment = await endpoints.createUpiPayment(orderUuid, { useQr: false });
            } else if (method === 'NETBANKING') {
                log('3. Create NetBanking payment', `POST /api/payment/nxpay/order/${orderUuid}/netbanking/payments`);
                payment = await endpoints.createNetbankingPayment(orderUuid, { payCode });
            } else {
                log('3. Create card payment', `POST /api/payment/nxpay/order/${orderUuid}/payments`);
                payment = await endpoints.createCardPayment(orderUuid, {
                    payments: [{ payment_option: { card_details: card } }]
                });
            }

            const paymentUuid = payment.data?.paymentId;
            if (!paymentUuid) throw new Error('Payment was not created.');
            log('↳ payment created', `uuid ${paymentUuid}`, 'ok');

            log('4. Awaiting signed provider webhook…', 'the state machine will apply it');
            await sleep(2800);

            const timeline = await endpoints.paymentTimeline(paymentUuid);
            const status = timeline.data?.status;
            log('5. Final status', status, status === 'PROCESSED' ? 'ok' : 'bad');

            setResult({
                orderUuid,
                paymentUuid,
                amount: value,
                status,
                timeline: timeline.data?.timeline || []
            });
        } catch (err) {
            setError(err.message || 'Simulation failed.');
            log('FAILED', err.message || 'unknown error', 'bad');
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="space-y-5">
            <div>
                <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Payment Simulator</h1>
                <p className="mt-1 text-sm text-slate-400">
                    Creates a real order + payment through the live APIs, then waits for the provider webhook.
                </p>
            </div>

            <ErrorNotice message={error} />

            <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                <Card title="New transaction" subtitle="Amount is in rupees (₹)">
                    <div className="space-y-3">
                        <Field label="Amount (₹)">
                            <TextInput
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                inputMode="decimal"
                                placeholder="250"
                            />
                        </Field>

                        <Field label="Method">
                            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                            </Select>
                        </Field>

                        {method === 'NETBANKING' && (
                            <Field label="Bank pay code" hint="Sandbox accepts any code, e.g. NB1531">
                                <TextInput value={payCode} onChange={(e) => setPayCode(e.target.value)} />
                            </Field>
                        )}

                        {method === 'CARD' && (
                            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                                <Field label="Card number" hint="Sandbox: ending 0002 declines">
                                    <TextInput
                                        value={card.card_number}
                                        onChange={(e) => setCard({ ...card, card_number: e.target.value })}
                                    />
                                </Field>
                                <div className="grid grid-cols-3 gap-2">
                                    <Field label="MM">
                                        <TextInput value={card.expiry_month} onChange={(e) => setCard({ ...card, expiry_month: e.target.value })} />
                                    </Field>
                                    <Field label="YYYY">
                                        <TextInput value={card.expiry_year} onChange={(e) => setCard({ ...card, expiry_year: e.target.value })} />
                                    </Field>
                                    <Field label="CVV">
                                        <TextInput value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value })} />
                                    </Field>
                                </div>
                                <Field label="Card holder">
                                    <TextInput value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} />
                                </Field>
                            </div>
                        )}

                        <Field label="Expected outcome" hint="Sandbox rule: a note containing 'FAIL' is declined">
                            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                                <option value="PROCESSED">Success (payment settles)</option>
                                <option value="FAILED">Failure (payment declined)</option>
                            </Select>
                        </Field>

                        <Field label="Idempotency-Key" hint="Sent on the order call — a duplicate key replays instead of double-charging">
                            <TextInput value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} />
                        </Field>

                        <div className="flex gap-2 pt-1">
                            <Button onClick={run} disabled={running}>
                                {running ? 'Running…' : 'Run transaction'}
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={running}
                                onClick={() => setIdempotencyKey(newIdempotencyKey('sim-order'))}
                            >
                                New key
                            </Button>
                        </div>
                    </div>
                </Card>

                <div className="space-y-4">
                    <Card title="Flow trace" subtitle="Each call the console makes, in order">
                        {steps.length === 0 ? (
                            <p className="py-8 text-center text-sm text-slate-400">
                                Run a transaction to see the pipeline execute.
                            </p>
                        ) : (
                            <ol className="space-y-2">
                                {steps.map((step, index) => (
                                    <li key={index} className="flex items-start justify-between gap-3 border-b border-slate-900/70 pb-2 last:border-0">
                                        <div>
                                            <p className={`text-xs font-medium ${TONE[step.tone]}`}>{step.label}</p>
                                            <p className="font-mono text-[11px] text-slate-400">{step.detail}</p>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </Card>

                    {result && (
                        <Card title="Result" subtitle="Read back from the operations API">
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                <div>
                                    <p className="text-xs uppercase tracking-wider text-slate-400">Amount</p>
                                    <p className="text-lg font-semibold text-slate-100">{formatCurrency(result.amount)}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase tracking-wider text-slate-400">Status</p>
                                    <div className="mt-0.5"><Badge value={result.status} /></div>
                                </div>
                                <div className="col-span-2">
                                    <p className="text-xs uppercase tracking-wider text-slate-400">Payment UUID</p>
                                    <p className="font-mono text-xs text-slate-300">{result.paymentUuid}</p>
                                </div>
                            </div>

                            <div className="mt-4">
                                <p className="mb-2 text-xs font-semibold text-slate-300">Timeline</p>
                                <ul className="space-y-1.5">
                                    {result.timeline.map((event, index) => (
                                        <li key={index} className="flex items-center justify-between gap-3 text-xs">
                                            <span className="text-slate-400">
                                                <span className="text-slate-200">{event.event}</span>
                                                {event.providerEvent ? ` · ${event.providerEvent}` : ''}
                                                {event.from || event.to ? ` · ${event.from || '∅'} → ${event.to || '∅'}` : ''}
                                            </span>
                                            <span className="whitespace-nowrap text-slate-400">
                                                {event.source} · {formatDateTime(event.at)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            <p className="mt-3 text-xs text-slate-400">
                                Now open <span className="text-slate-300">Live Ops</span> and{' '}
                                <span className="text-slate-300">Dashboard</span> — the numbers there move in real time from this event.
                            </p>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
