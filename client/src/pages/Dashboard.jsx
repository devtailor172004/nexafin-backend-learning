import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Card, ErrorNotice, EmptyState, Spinner, StatCard } from '../components/ui.jsx';
import { percent, formatCurrency, formatNumber, formatSeconds } from '../lib/format.js';

const REFRESH_MS = 20000;

export default function Dashboard() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            const response = await endpoints.dashboard();
            setData(response.data);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load the dashboard.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    if (loading && !data) return <Spinner label="Loading dashboard…" />;

    const payments = data?.payments || {};
    const webhooks = data?.webhooks || {};
    const byStatus = payments.byStatus || {};
    const byMethod = payments.byMethod || {};

    const statusEntries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
    const methodEntries = Object.entries(byMethod).sort((a, b) => b[1] - a[1]);
    const statusTotal = statusEntries.reduce((sum, [, count]) => sum + count, 0);

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold text-slate-100">Operations Dashboard</h1>
                    <p className="text-xs text-slate-500">
                        Today · since {data?.since ? new Date(data.since).toLocaleString('en-IN') : '—'} · auto-refreshes every 20s
                    </p>
                </div>
                <p className="text-xs text-slate-500">Live subscribers: {data?.realtime?.subscribers ?? 0}</p>
            </div>

            <ErrorNotice message={error} onRetry={load} />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <StatCard label="Success rate" value={percent(payments.successRate)} tone={(payments.successRate ?? 0) >= 95 ? 'good' : 'warn'} />
                <StatCard label="Payments" value={formatNumber(payments.total)} hint="today" />
                <StatCard label="Succeeded" value={formatNumber(payments.succeeded)} tone="good" />
                <StatCard label="Failed" value={formatNumber(payments.failed)} tone={payments.failed ? 'bad' : 'default'} />
                <StatCard label="In flight" value={formatNumber(payments.pending)} tone="warn" />
                <StatCard label="Refunds" value={formatNumber(payments.refunds)} tone="info" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Gross processed value" subtitle="Sum of all payments created today">
                    <p className="text-3xl font-semibold tabular-nums text-slate-100">{formatCurrency(payments.grossAmount)}</p>
                    <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                        <div className="rounded-lg bg-slate-900/60 p-3">
                            <p className="text-slate-500">Orders</p>
                            <p className="mt-1 text-base font-semibold text-slate-200">{formatNumber(data?.orders?.total)}</p>
                        </div>
                        <div className="rounded-lg bg-slate-900/60 p-3">
                            <p className="text-slate-500">Cancelled</p>
                            <p className="mt-1 text-base font-semibold text-slate-200">{formatNumber(payments.cancelled)}</p>
                        </div>
                        <div className="rounded-lg bg-slate-900/60 p-3">
                            <p className="text-slate-500">Expired</p>
                            <p className="mt-1 text-base font-semibold text-slate-200">{formatNumber(payments.expired)}</p>
                        </div>
                    </div>
                </Card>

                <Card title="Webhook health" subtitle="Provider webhook ledger (today)">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <StatCard label="Received" value={formatNumber(webhooks.total)} />
                        <StatCard label="Processed" value={formatNumber(webhooks.processed)} tone="good" />
                        <StatCard label="Failed" value={formatNumber(webhooks.failed)} tone={webhooks.failed ? 'bad' : 'default'} />
                        <StatCard label="Avg delay" value={formatSeconds(webhooks.avgDelaySeconds)} tone="info" />
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                        Duplicates suppressed: {formatNumber(webhooks.duplicatesSuppressed)}
                    </p>
                </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Status breakdown" subtitle="Distribution of payment states today">
                    {statusEntries.length === 0 ? (
                        <EmptyState title="No payments yet today" description="Statuses appear here as soon as the first payment is created." />
                    ) : (
                        <ul className="space-y-3">
                            {statusEntries.map(([status, count]) => {
                                const width = statusTotal ? Math.max(4, (count / statusTotal) * 100) : 0;
                                return (
                                    <li key={status}>
                                        <div className="flex items-center justify-between text-xs">
                                            <Badge value={status} />
                                            <span className="tabular-nums text-slate-300">{formatNumber(count)}</span>
                                        </div>
                                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                                            <div className="h-full rounded-full bg-sky-500" style={{ width: `${width}%` }} />
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Card>

                <Card title="Payment methods" subtitle="Volume by method today">
                    {methodEntries.length === 0 ? (
                        <EmptyState title="No method data yet" />
                    ) : (
                        <ul className="space-y-3">
                            {methodEntries.map(([method, count]) => {
                                const total = methodEntries.reduce((sum, [, c]) => sum + c, 0);
                                const width = total ? Math.max(4, (count / total) * 100) : 0;
                                return (
                                    <li key={method}>
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="font-medium text-slate-300">{method}</span>
                                            <span className="tabular-nums text-slate-400">{formatNumber(count)}</span>
                                        </div>
                                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                                            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${width}%` }} />
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Card>
            </div>

            {data?.reconciliation && !data.reconciliation.implemented && (
                <Card title="Reconciliation Center" subtitle="Planned for the next phase">
                    <p className="text-xs text-slate-400">
                        The Reconciliation Center (internal ledger vs provider report vs settlement) is scoped for Phase 2.
                        No exception figures are shown to avoid displaying numbers that are not backed by real data.
                    </p>
                </Card>
            )}
        </div>
    );
}
