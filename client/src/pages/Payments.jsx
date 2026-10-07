import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, EmptyState, ErrorNotice, Select, Spinner, TextInput } from '../components/ui.jsx';
import { formatCurrency, formatDateTime, formatTime } from '../lib/format.js';

const STATUSES = ['', 'CREATED', 'PENDING', 'AUTHORIZED', 'PROCESSED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'];

function TimelineList({ timeline }) {
    if (!timeline?.length) {
        return <EmptyState title="No timeline events recorded" description="Events are written by the payment event engine." />;
    }

    return (
        <ol className="relative space-y-4 border-l border-slate-800 pl-5">
            {timeline.map((item, index) => (
                <li key={`${item.at}-${index}`} className="relative">
                    <span className={`absolute -left-[23px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-[#0e1526] ${item.rejected ? 'bg-rose-500' : 'bg-sky-500'}`} />
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-200">{item.event}</span>
                        <span className="text-[11px] tabular-nums text-slate-500">{formatTime(item.at)}</span>
                        {item.from || item.to ? (
                            <span className="text-[11px] text-slate-500">
                                {item.from || '—'} → {item.to || '—'}
                            </span>
                        ) : null}
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{item.source}</span>
                    </div>
                    {item.message && <p className="mt-1 text-xs text-slate-400">{item.message}</p>}
                </li>
            ))}
        </ol>
    );
}

function PaymentDetail({ paymentId, onClose }) {
    const [timeline, setTimeline] = useState(null);
    const [explain, setExplain] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setLoading(true);
            try {
                const [timelineResponse, explainResponse] = await Promise.all([
                    endpoints.paymentTimeline(paymentId),
                    endpoints.explainPayment(paymentId)
                ]);
                if (cancelled) return;
                setTimeline(timelineResponse.data?.timeline || []);
                setExplain(explainResponse.data);
                setError(null);
            } catch (err) {
                if (!cancelled) setError(err.message || 'Failed to load payment detail.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [paymentId]);

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            <div className="absolute inset-0 bg-black/60" onClick={onClose} />
            <aside className="relative h-full w-full max-w-xl overflow-y-auto border-l border-slate-800 bg-[#0b1120] p-4 sm:p-6">
                <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                        <p className="text-[11px] uppercase tracking-wider text-slate-500">Payment detail</p>
                        <p className="mt-1 break-all font-mono text-xs text-slate-300">{paymentId}</p>
                    </div>
                    <Button variant="secondary" onClick={onClose}>Close</Button>
                </div>

                {loading && !explain ? (
                    <Spinner label="Loading payment…" />
                ) : (
                    <div className="space-y-4">
                        <ErrorNotice message={error} />

                        {explain && (
                            <Card title="Why this payment is in this state" subtitle="Derived from the event timeline">
                                <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                                    <div className="rounded-lg bg-slate-900/60 p-3">
                                        <p className="text-slate-500">Status</p>
                                        <div className="mt-1"><Badge value={explain.status} /></div>
                                    </div>
                                    <div className="rounded-lg bg-slate-900/60 p-3">
                                        <p className="text-slate-500">Stage</p>
                                        <p className="mt-1 font-medium text-slate-200">{explain.stage}</p>
                                    </div>
                                    <div className="rounded-lg bg-slate-900/60 p-3">
                                        <p className="text-slate-500">Provider</p>
                                        <p className="mt-1 font-medium text-slate-200">{explain.provider}</p>
                                    </div>
                                    <div className="rounded-lg bg-slate-900/60 p-3">
                                        <p className="text-slate-500">Error code</p>
                                        <p className="mt-1 font-medium text-slate-200">{explain.errorCode || '—'}</p>
                                    </div>
                                    <div className="rounded-lg bg-slate-900/60 p-3">
                                        <p className="text-slate-500">Webhook received</p>
                                        <p className="mt-1 font-medium text-slate-200">{explain.webhookReceived ? 'Yes' : 'No'}</p>
                                    </div>
                                    <div className="rounded-lg bg-slate-900/60 p-3">
                                        <p className="text-slate-500">Retry</p>
                                        <p className={`mt-1 font-medium ${explain.retryRecommended ? 'text-emerald-300' : 'text-slate-300'}`}>
                                            {explain.failed ? (explain.retryRecommended ? 'Recommended' : 'Not recommended') : 'Not applicable'}
                                        </p>
                                    </div>
                                </div>
                                {explain.errorMessage && (
                                    <p className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                                        {explain.errorMessage}
                                    </p>
                                )}
                                {explain.webhook && (
                                    <p className="mt-3 text-[11px] text-slate-500">
                                        Last webhook: {explain.webhook.eventType} · {explain.webhook.status} · attempts {explain.webhook.attempts} ·
                                        signature {explain.webhook.signatureVerified ? 'verified' : 'not verified'}
                                    </p>
                                )}
                            </Card>
                        )}

                        <Card title="Timeline" subtitle="Append-only payment events">
                            <TimelineList timeline={timeline} />
                        </Card>
                    </div>
                )}
            </aside>
        </div>
    );
}

export default function Payments() {
    const [status, setStatus] = useState('');
    const [orderId, setOrderId] = useState('');
    const [page, setPage] = useState(1);
    const [rows, setRows] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null);

    const load = useCallback(async () => {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (status) params.set('status', status);
        if (orderId.trim()) params.set('orderId', orderId.trim());

        setLoading(true);
        try {
            const response = await endpoints.liveTransactions(`?${params.toString()}`);
            setRows(response.data?.transactions || []);
            setPagination(response.data?.pagination || null);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load payments.');
        } finally {
            setLoading(false);
        }
    }, [page, status, orderId]);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="space-y-5">
            <div>
                <h1 className="text-lg font-semibold text-slate-100">Payments</h1>
                <p className="text-xs text-slate-500">Search, inspect and explain any payment</p>
            </div>

            <ErrorNotice message={error} onRetry={load} />

            <Card
                title="Payment ledger"
                actions={(
                    <div className="flex flex-wrap gap-2">
                        <TextInput
                            placeholder="Provider order id"
                            value={orderId}
                            onChange={(e) => { setOrderId(e.target.value); setPage(1); }}
                            className="w-44"
                        />
                        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40">
                            {STATUSES.map((value) => <option key={value || 'all'} value={value}>{value || 'All statuses'}</option>)}
                        </Select>
                    </div>
                )}
            >
                {loading && rows.length === 0 ? (
                    <Spinner label="Loading payments…" />
                ) : rows.length === 0 ? (
                    <EmptyState title="No payments found" description="Adjust the filters or create a test payment." />
                ) : (
                    <div className="-mx-4 overflow-x-auto sm:mx-0">
                        <table className="w-full min-w-[720px] text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                                    <th className="px-3 py-2 font-medium">Created</th>
                                    <th className="px-3 py-2 font-medium">Payment</th>
                                    <th className="px-3 py-2 font-medium">Customer</th>
                                    <th className="px-3 py-2 font-medium">Amount</th>
                                    <th className="px-3 py-2 font-medium">Method</th>
                                    <th className="px-3 py-2 font-medium">Status</th>
                                    <th className="px-3 py-2 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row) => (
                                    <tr key={row.paymentId} className="border-b border-slate-900/70 last:border-0 hover:bg-slate-900/40">
                                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{formatDateTime(row.createdAt)}</td>
                                        <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{String(row.paymentId).slice(0, 8)}…</td>
                                        <td className="px-3 py-2 text-xs text-slate-400">{row.customerEmail || '—'}</td>
                                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-200">{formatCurrency(row.amount, row.currency)}</td>
                                        <td className="px-3 py-2 text-xs text-slate-400">{row.method}</td>
                                        <td className="px-3 py-2"><Badge value={row.status} /></td>
                                        <td className="px-3 py-2 text-right">
                                            <Button variant="ghost" onClick={() => setSelected(row.paymentId)}>Inspect</Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {pagination && pagination.totalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                        <span>Page {pagination.currentPage} of {pagination.totalPages} · {pagination.totalItems} total</span>
                        <div className="flex gap-2">
                            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
                            <Button variant="secondary" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                        </div>
                    </div>
                )}
            </Card>

            {selected && <PaymentDetail paymentId={selected} onClose={() => setSelected(null)} />}
        </div>
    );
}
