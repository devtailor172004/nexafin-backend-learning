import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Select, Spinner, StatCard, TextInput } from '../components/ui.jsx';
import { formatDateTime, formatNumber } from '../lib/format.js';

const EXCEPTION_TYPES = ['', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER', 'DUPLICATE', 'SETTLEMENT_MISMATCH'];
const EXCEPTION_STATUSES = ['', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED'];

const severityTone = (severity) => {
    if (severity === 'HIGH') return 'FAILED';
    if (severity === 'MEDIUM') return 'PENDING';
    return 'CREATED';
};

function ExceptionActionModal({ exception, onClose, onDone }) {
    const [action, setAction] = useState('INVESTIGATE');
    const [note, setNote] = useState('');
    const [assignedToId, setAssignedToId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await endpoints.updateReconciliationException(exception.uuid, {
                action,
                note: note || undefined,
                assignedToId: action === 'ASSIGN' ? Number(assignedToId) : undefined
            });
            onDone();
        } catch (err) {
            setError(err.message || 'Failed to update the exception.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60" onClick={onClose} />
            <form onSubmit={submit} className="relative w-full max-w-md space-y-4 rounded-2xl border border-slate-800 bg-[#0b1120] p-5">
                <div>
                    <h2 className="text-sm font-semibold text-slate-100">Exception workflow</h2>
                    <p className="mt-1 text-xs text-slate-400">
                        {exception.type} · {exception.matchKey || '—'} · currently {exception.status}
                    </p>
                </div>

                <Field label="Action">
                    <Select value={action} onChange={(e) => setAction(e.target.value)}>
                        <option value="INVESTIGATE">Start investigating</option>
                        <option value="ASSIGN">Assign to a user</option>
                        <option value="RESOLVE">Resolve</option>
                        <option value="IGNORE">Ignore</option>
                    </Select>
                </Field>

                {action === 'ASSIGN' && (
                    <Field label="Assign to user id" hint="Numeric user id">
                        <TextInput
                            required
                            inputMode="numeric"
                            value={assignedToId}
                            onChange={(e) => setAssignedToId(e.target.value)}
                            placeholder="1"
                        />
                    </Field>
                )}

                <Field label="Note" hint={action === 'RESOLVE' || action === 'IGNORE' ? 'Required' : 'Optional'}>
                    <TextInput
                        required={action === 'RESOLVE' || action === 'IGNORE'}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="What did you find?"
                    />
                </Field>

                <ErrorNotice message={error} />

                <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Apply'}</Button>
                </div>
            </form>
        </div>
    );
}

export default function Reconciliation() {
    const [summary, setSummary] = useState(null);
    const [runs, setRuns] = useState([]);
    const [exceptions, setExceptions] = useState([]);
    const [type, setType] = useState('');
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [active, setActive] = useState(null);

    const load = useCallback(async () => {
        try {
            const params = new URLSearchParams({ limit: '25' });
            if (type) params.set('type', type);
            if (status) params.set('status', status);

            const [summaryResponse, runsResponse, exceptionsResponse] = await Promise.all([
                endpoints.reconciliationSummary(),
                endpoints.reconciliationRuns('?limit=5'),
                endpoints.reconciliationExceptions(`?${params.toString()}`)
            ]);

            setSummary(summaryResponse.data);
            setRuns(runsResponse.data?.runs || []);
            setExceptions(exceptionsResponse.data?.exceptions || []);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load reconciliation data.');
        } finally {
            setLoading(false);
        }
    }, [type, status]);

    useEffect(() => { load(); }, [load]);

    const startRun = async () => {
        setRunning(true);
        setError(null);
        setNotice(null);
        try {
            const response = await endpoints.createReconciliationRun({ simulate: true });
            setNotice(response.message);
            await load();
        } catch (err) {
            setError(err.message || 'Failed to run reconciliation.');
        } finally {
            setRunning(false);
        }
    };

    if (loading && !summary) return <Spinner label="Loading reconciliation centre…" />;

    const byType = summary?.byType || {};

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Reconciliation Center</h1>
                    <p className="mt-1 text-sm text-slate-400">Internal ledger vs provider report, with an exception workflow</p>
                </div>
                <Button onClick={startRun} disabled={running}>{running ? 'Running…' : 'Run reconciliation'}</Button>
            </div>

            <ErrorNotice message={error} onRetry={load} />
            {notice && (
                <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
                    {notice}
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <StatCard label="Open exceptions" value={formatNumber(summary?.openExceptions)} tone={summary?.openExceptions ? 'bad' : 'good'} />
                <StatCard label="Amount mismatch" value={formatNumber(byType.AMOUNT_MISMATCH)} tone={byType.AMOUNT_MISMATCH ? 'warn' : 'default'} />
                <StatCard label="Status mismatch" value={formatNumber(byType.STATUS_MISMATCH)} />
                <StatCard label="Missing internal" value={formatNumber(byType.MISSING_INTERNAL)} />
                <StatCard label="Missing provider" value={formatNumber(byType.MISSING_PROVIDER)} />
                <StatCard label="Duplicates" value={formatNumber(byType.DUPLICATE)} />
            </div>

            <Card title="Latest runs" subtitle="Each run compares the internal ledger against a provider report">
                {runs.length === 0 ? (
                    <EmptyState
                        title="No reconciliation runs yet"
                        description="Run a reconciliation to compare the internal ledger with a provider report."
                    />
                ) : (
                    <div className="-mx-4 overflow-x-auto sm:mx-0">
                        <table className="w-full min-w-[680px] text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-700 bg-slate-900/60 text-xs font-semibold uppercase tracking-wider text-slate-300">
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Completed</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Source</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Period</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Internal</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Provider</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Matched</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Exceptions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {runs.map((run) => (
                                    <tr key={run.uuid} className="border-b border-slate-900/70 last:border-0">
                                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{formatDateTime(run.completedAt)}</td>
                                        <td className="px-3 py-2">
                                            <Badge value={run.source === 'SIMULATED' ? 'PENDING' : 'PROCESSED'} />
                                            <span className="ml-2 text-xs text-slate-400">
                                                {run.source === 'SIMULATED' ? 'Simulated report' : 'Provider report'}
                                            </span>
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                                            {formatDateTime(run.periodStart)} → {formatDateTime(run.periodEnd)}
                                        </td>
                                        <td className="px-3 py-2 tabular-nums text-slate-300">{formatNumber(run.internalCount)}</td>
                                        <td className="px-3 py-2 tabular-nums text-slate-300">{formatNumber(run.providerCount)}</td>
                                        <td className="px-3 py-2 tabular-nums text-emerald-300">{formatNumber(run.matchedCount)}</td>
                                        <td className="px-3 py-2 tabular-nums text-rose-300">{formatNumber(run.exceptionCount)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Card
                title="Exceptions"
                subtitle="Assign, investigate and resolve discrepancies"
                actions={(
                    <div className="flex flex-wrap gap-2">
                        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-44">
                            {EXCEPTION_TYPES.map((value) => <option key={value || 'all'} value={value}>{value || 'All types'}</option>)}
                        </Select>
                        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
                            {EXCEPTION_STATUSES.map((value) => <option key={value || 'all'} value={value}>{value || 'All statuses'}</option>)}
                        </Select>
                    </div>
                )}
            >
                {exceptions.length === 0 ? (
                    <EmptyState title="No exceptions match these filters" description="This is a good sign." />
                ) : (
                    <div className="-mx-4 overflow-x-auto sm:mx-0">
                        <table className="w-full min-w-[860px] text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-700 bg-slate-900/60 text-xs font-semibold uppercase tracking-wider text-slate-300">
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Type</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Severity</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Reference</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Expected</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Actual</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold">Status</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-semibold" />
                                </tr>
                            </thead>
                            <tbody>
                                {exceptions.map((exception) => (
                                    <tr key={exception.uuid} className="border-b border-slate-900/70 last:border-0 hover:bg-slate-900/40">
                                        <td className="px-3 py-2 text-xs font-medium text-slate-200">{exception.type}</td>
                                        <td className="px-3 py-2"><Badge value={severityTone(exception.severity)} /></td>
                                        <td className="px-3 py-2 text-xs text-slate-400">
                                            <p className="font-mono">{exception.merchantPaymentReference || '—'}</p>
                                            {exception.run?.source === 'SIMULATED' && <p className="text-[11px] text-amber-400/80">simulated report</p>}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-slate-400">
                                            {exception.expectedAmount ?? '—'} {exception.expectedStatus || ''}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-slate-400">
                                            {exception.actualAmount ?? '—'} {exception.actualStatus || ''}
                                        </td>
                                        <td className="px-3 py-2"><Badge value={exception.status} /></td>
                                        <td className="px-3 py-2 text-right">
                                            <Button variant="ghost" onClick={() => setActive(exception)}>Workflow</Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            {active && (
                <ExceptionActionModal
                    exception={active}
                    onClose={() => setActive(null)}
                    onDone={async () => { setActive(null); await load(); }}
                />
            )}
        </div>
    );
}
