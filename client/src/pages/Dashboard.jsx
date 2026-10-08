import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useLiveStream } from '../lib/useLiveStream.js';
import { Badge, Button, Card, ErrorNotice, EmptyState, Spinner, StatCard } from '../components/ui.jsx';
import { percent, formatCurrency, formatNumber, formatSeconds, formatDateTime } from '../lib/format.js';

const REFRESH_MS = 20000;

export default function Dashboard() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState(null);
    const [settling, setSettling] = useState(false);

    // Live KPI refresh: any payment event on the SSE stream re-pulls the
    // dashboard (debounced), so the numbers move in real time rather than
    // waiting for the next 20s poll.
    const { events, status: streamStatus } = useLiveStream({ enabled: true });
    const latestEventId = events[0]?.id;

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

    useEffect(() => {
        if (!latestEventId) return undefined;
        const timer = setTimeout(() => { load(); }, 700);
        return () => clearTimeout(timer);
    }, [latestEventId, load]);

    const settle = useCallback(async () => {
        setSettling(true);
        setError(null);
        setNotice(null);
        try {
            const response = await endpoints.runSettlement({});
            setNotice(`Settled ${formatNumber(response.data?.settledCount)} payment(s) under ${response.data?.reference || '—'}.`);
            await load();
        } catch (err) {
            setError(err.message || 'Settlement run failed.');
        } finally {
            setSettling(false);
        }
    }, [load]);

    if (loading && !data) return <Spinner label="Loading dashboard…" />;

    const payments = data?.payments || {};
    const webhooks = data?.webhooks || {};
    const settlement = data?.settlement || { unsettled: { count: 0, amount: 0 }, settled: { count: 0, amount: 0 }, settledToday: { count: 0, amount: 0 } };
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
                <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Badge value={streamStatus === 'connected' ? 'Live' : streamStatus} />
                    <span>Live subscribers: {data?.realtime?.subscribers ?? 0}</span>
                </div>
            </div>

            <ErrorNotice message={error} onRetry={load} />
            {notice && (
                <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">{notice}</div>
            )}

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

            {data?.settlement?.implemented && (
                <Card
                    title="Settlement"
                    subtitle="Captured funds moved by the acquirer into the merchant account"
                    actions={(
                        <Button variant="secondary" onClick={settle} disabled={settling}>
                            {settling ? 'Settling…' : 'Run settlement'}
                        </Button>
                    )}
                >
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <StatCard label="Unsettled amount" value={formatCurrency(settlement.unsettled.amount)} tone={settlement.unsettled.amount ? 'warn' : 'good'} />
                        <StatCard label="Unsettled payments" value={formatNumber(settlement.unsettled.count)} />
                        <StatCard label="Settled amount" value={formatCurrency(settlement.settled.amount)} tone="good" />
                        <StatCard label="Settled today" value={formatNumber(settlement.settledToday.count)} tone="info" hint={formatCurrency(settlement.settledToday.amount)} />
                    </div>
                </Card>
            )}

            {data?.reconciliation?.implemented && (
                <Card
                    title="Reconciliation Center"
                    subtitle="Open exceptions across all reconciliation runs"
                    actions={data.reconciliation.latestRun ? (
                        <Badge value={data.reconciliation.latestRun.source === 'SIMULATED' ? 'PENDING' : 'PROCESSED'} />
                    ) : null}
                >
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <StatCard
                            label="Open exceptions"
                            value={formatNumber(data.reconciliation.openExceptions)}
                            tone={data.reconciliation.openExceptions ? 'bad' : 'good'}
                        />
                        <StatCard label="Amount mismatch" value={formatNumber(data.reconciliation.byType?.AMOUNT_MISMATCH)} />
                        <StatCard label="Status mismatch" value={formatNumber(data.reconciliation.byType?.STATUS_MISMATCH)} />
                        <StatCard label="Duplicates" value={formatNumber(data.reconciliation.byType?.DUPLICATE)} />
                    </div>

                    {data.reconciliation.latestRun ? (
                        <p className="mt-3 text-[11px] text-slate-500">
                            Latest run: {data.reconciliation.latestRun.matchedCount} matched,{' '}
                            {data.reconciliation.latestRun.exceptionCount} exception(s), completed{' '}
                            {formatDateTime(data.reconciliation.latestRun.completedAt)}
                            {data.reconciliation.latestRun.source === 'SIMULATED' && ' — from a SIMULATED provider report'}
                        </p>
                    ) : (
                        <p className="mt-3 text-[11px] text-slate-500">
                            No reconciliation run yet. Open the Reconciliation page to compare the internal ledger with a provider report.
                        </p>
                    )}
                </Card>
            )}
        </div>
    );
}
