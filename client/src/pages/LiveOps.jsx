import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useLiveStream } from '../lib/useLiveStream.js';
import { Badge, Button, Card, EmptyState, ErrorNotice, Select, Spinner } from '../components/ui.jsx';
import { formatCurrency, formatDateTime, formatTime } from '../lib/format.js';

const REFRESH_MS = 10000;
const STATUSES = ['', 'CREATED', 'PENDING', 'AUTHORIZED', 'PROCESSED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'];
const METHODS = ['', 'UPI', 'CARD', 'NETBANKING'];

const streamBadge = {
    connected: { text: 'Live', tone: 'PROCESSED' },
    connecting: { text: 'Connecting', tone: 'PENDING' },
    reconnecting: { text: 'Reconnecting', tone: 'FAILED' },
    idle: { text: 'Idle', tone: 'CANCELLED' },
    error: { text: 'Offline', tone: 'FAILED' }
};

export default function LiveOps() {
    const [status, setStatusFilter] = useState('');
    const [method, setMethodFilter] = useState('');
    const [transactions, setTransactions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showStream, setShowStream] = useState(true);

    const { events, status: streamStatus, error: streamError, clear } = useLiveStream({ enabled: showStream });

    const load = useCallback(async () => {
        const params = new URLSearchParams({ limit: '30' });
        if (status) params.set('status', status);
        if (method) params.set('method', method);

        try {
            const response = await endpoints.liveTransactions(`?${params.toString()}`);
            setTransactions(response.data?.transactions || []);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load transactions.');
        } finally {
            setLoading(false);
        }
    }, [status, method]);

    useEffect(() => {
        setLoading(true);
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    const badge = streamBadge[streamStatus] || streamBadge.idle;

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold text-slate-100">Live Operations</h1>
                    <p className="text-xs text-slate-400">Streaming payment events and recent transactions</p>
                </div>
                <div className="flex items-center gap-3">
                    <Badge value={badge.text} />
                    <Button variant="secondary" onClick={() => setShowStream((value) => !value)}>
                        {showStream ? 'Pause stream' : 'Resume stream'}
                    </Button>
                </div>
            </div>

            <ErrorNotice message={error} onRetry={load} />
            {streamError && showStream && streamStatus === 'error' && <ErrorNotice message={streamError} />}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                <Card
                    title="Event stream"
                    subtitle="Server-Sent Events from the payment event engine"
                    actions={events.length > 0 ? (
                        <button onClick={clear} className="text-xs text-slate-400 hover:text-slate-200">Clear</button>
                    ) : null}
                >
                    {events.length === 0 ? (
                        <EmptyState
                            title="Waiting for activity"
                            description="New payment events appear here in real time as webhooks and API calls are processed."
                        />
                    ) : (
                        <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                            {events.map((event) => (
                                <li key={event.id} className="animate-punch rounded-lg border border-slate-800 bg-slate-900/50 p-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs font-semibold text-sky-300">{event.eventType || event.kind || 'event'}</span>
                                        <span className="text-xs tabular-nums text-slate-400">{formatTime(event.at)}</span>
                                    </div>
                                    {event.message && <p className="mt-1 text-xs text-slate-400">{event.message}</p>}
                                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                        {event.statusTo && <Badge value={event.statusTo} />}
                                        {event.isRejected && <Badge value="REJECTED" />}
                                        {event.source && <span className="text-[11px] uppercase tracking-wide text-slate-400">{event.source}</span>}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                <Card
                    title="Recent transactions"
                    subtitle="Auto-refreshes every 10 seconds"
                    actions={(
                        <div className="flex gap-2">
                            <Select value={status} onChange={(e) => setStatusFilter(e.target.value)} className="w-40">
                                {STATUSES.map((value) => <option key={value || 'all'} value={value}>{value || 'All statuses'}</option>)}
                            </Select>
                            <Select value={method} onChange={(e) => setMethodFilter(e.target.value)} className="w-36">
                                {METHODS.map((value) => <option key={value || 'all'} value={value}>{value || 'All methods'}</option>)}
                            </Select>
                        </div>
                    )}
                >
                    {loading && transactions.length === 0 ? (
                        <Spinner label="Loading transactions…" />
                    ) : transactions.length === 0 ? (
                        <EmptyState title="No transactions match these filters" />
                    ) : (
                        <div className="-mx-4 overflow-x-auto sm:mx-0">
                            <table className="w-full min-w-[640px] text-left text-sm">
                                <thead>
                                    <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-400">
                                        <th className="px-3 py-2 font-medium">Time</th>
                                        <th className="px-3 py-2 font-medium">Payment</th>
                                        <th className="px-3 py-2 font-medium">Amount</th>
                                        <th className="px-3 py-2 font-medium">Method</th>
                                        <th className="px-3 py-2 font-medium">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {transactions.map((tx) => (
                                        <tr key={tx.paymentId} className="border-b border-slate-900/70 last:border-0 hover:bg-slate-900/40">
                                            <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{formatDateTime(tx.createdAt)}</td>
                                            <td className="px-3 py-2">
                                                <p className="font-mono text-xs text-slate-300">{String(tx.paymentId).slice(0, 8)}…</p>
                                                <p className="text-xs text-slate-400">{tx.customerEmail || '—'}</p>
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-200">{formatCurrency(tx.amount, tx.currency)}</td>
                                            <td className="px-3 py-2 text-xs text-slate-400">{tx.method}</td>
                                            <td className="px-3 py-2">
                                                <Badge value={tx.status} />
                                                {tx.errorCode && <p className="mt-1 text-[11px] text-rose-300">{tx.errorCode}</p>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
}
