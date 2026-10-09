import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatNumber } from '../lib/format.js';
import {
    Badge,
    Button,
    Card,
    EmptyState,
    ErrorNotice,
    Field,
    Select,
    Spinner,
    StatCard,
    TextInput
} from '../components/ui.jsx';

const TABS = [
    { id: 'overview', label: 'Security Overview' },
    { id: 'events', label: 'Security Event Explorer' },
    { id: 'incidents', label: 'Incident Details' },
    { id: 'freezes', label: 'Account Freeze Controls' },
    { id: 'integrity', label: 'Audit & Ledger Integrity' }
];

const toQuery = (params) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== '' && value !== null && value !== undefined) search.set(key, value);
    });
    const qs = search.toString();
    return qs ? `?${qs}` : '';
};

const money = (minor) => `₹${(Number(minor || 0) / 100).toFixed(2)}`;

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

function Overview({ onOpenIncident }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setData(await endpoints.securityOverview());
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (loading && !data) return <Spinner label="Loading security overview…" />;
    if (error && !data) return <ErrorNotice message={error} onRetry={load} />;

    const risk = data?.risk || {};
    const integrity = data?.integrity;
    const ledger = data?.ledger;

    return (
        <div className="space-y-4">
            <ErrorNotice message={error} onRetry={load} />

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Open risk alerts" value={formatNumber(risk.openAlerts)} tone={risk.openAlerts ? 'warn' : 'good'} hint="Holds/blocks awaiting review" />
                <StatCard label="High / critical (24h)" value={formatNumber(risk.highRiskToday)} tone={risk.highRiskToday ? 'bad' : 'good'} />
                <StatCard label="Blocked (24h)" value={formatNumber(risk.blockedToday)} tone={risk.blockedToday ? 'bad' : 'default'} />
                <StatCard label="Attempts evaluated (24h)" value={formatNumber(risk.evaluatedToday)} tone="info" />
                <StatCard label="Active account freezes" value={formatNumber(data?.freezes?.active)} tone={data?.freezes?.active ? 'bad' : 'good'} />
                <StatCard label="Open incidents" value={formatNumber(data?.incidents?.open)} tone={data?.incidents?.open ? 'warn' : 'good'} />
                <StatCard label="Webhook failures (7d)" value={formatNumber(data?.webhooks?.verificationFailures7d)} tone={data?.webhooks?.verificationFailures7d ? 'warn' : 'good'} />
                <StatCard label="Auth security events (24h)" value={formatNumber(data?.auth?.securityEvents24h)} tone="info" />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
                <Card title="Audit integrity" subtitle="Hash-chained tamper evidence">
                    {integrity ? (
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-slate-400">Chain status</span>
                                <Badge value={integrity.valid === null ? 'UNKNOWN' : integrity.valid ? 'VALID' : 'INVALID'} />
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-slate-400">Records verified</span>
                                <span className="tabular-nums text-slate-200">{formatNumber(integrity.checked)}</span>
                            </div>
                            {!integrity.valid && integrity.firstInvalidSequence != null && (
                                <p className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                                    First invalid record at sequence {integrity.firstInvalidSequence} ({integrity.reason}).
                                </p>
                            )}
                        </div>
                    ) : <p className="text-sm text-slate-400">Not checked.</p>}
                </Card>

                <Card title="Ledger invariants" subtitle="Double-entry balance protection">
                    {ledger ? (
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-slate-400">Status</span>
                                <Badge value={ledger.ok === null ? 'UNKNOWN' : ledger.ok ? 'VALID' : 'INVALID'} />
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-slate-400">Journals checked</span>
                                <span className="tabular-nums text-slate-200">{formatNumber(ledger.journalsChecked)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-slate-400">Debits = Credits</span>
                                <span className="tabular-nums text-slate-200">
                                    {money(ledger.totalDebitMinor)} / {money(ledger.totalCreditMinor)}
                                </span>
                            </div>
                        </div>
                    ) : <p className="text-sm text-slate-400">Not checked.</p>}
                </Card>

                <Card title="Recent incidents" subtitle="Newest 5">
                    {(data?.incidents?.recent || []).length === 0 ? (
                        <EmptyState title="No incidents" description="No security incidents have been opened." />
                    ) : (
                        <ul className="space-y-2">
                            {data.incidents.recent.map((incident) => (
                                <li key={incident.id}>
                                    <button
                                        onClick={() => onOpenIncident(incident.id)}
                                        className="w-full rounded-xl border border-slate-800 px-3 py-2 text-left hover:border-slate-700 hover:bg-slate-900/40"
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="truncate text-sm text-slate-200">{incident.title}</span>
                                            <Badge value={incident.severity} />
                                        </div>
                                        <p className="mt-0.5 text-xs text-slate-400">{formatDateTime(incident.createdAt)}</p>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Event explorer
 * ------------------------------------------------------------------ */

function EventExplorer({ selectedId, onSelected }) {
    const toast = useToast();
    const [filters, setFilters] = useState({ decision: '', riskLevel: '', status: 'OPEN', search: '' });
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [detail, setDetail] = useState(null);
    const [reason, setReason] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await endpoints.securityEvents(toQuery({ ...filters, limit: 50 }));
            setItems(result?.data?.items || []);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [filters]);

    useEffect(() => { load(); }, [load]);

    const openDetail = async (uuid) => {
        try {
            const result = await endpoints.securityEvent(uuid);
            setDetail(result?.data || null);
            onSelected?.(uuid);
        } catch (err) {
            toast.error(err.message);
        }
    };

    const review = async (action) => {
        if (reason.trim().length < 5) {
            toast.error('A review reason of at least 5 characters is required.');
            return;
        }
        try {
            await endpoints.reviewSecurityEvent(detail.event.id, { action, reason });
            toast.success(`Risk event ${action.toLowerCase()}d.`);
            setReason('');
            setDetail(null);
            await load();
        } catch (err) {
            toast.error(err.message);
        }
    };

    return (
        <div className="space-y-4">
            <Card title="Filters" subtitle="Server-side filtering and pagination">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Decision">
                        <Select value={filters.decision} onChange={(e) => setFilters({ ...filters, decision: e.target.value })}>
                            <option value="">All</option>
                            <option value="ALLOW">ALLOW</option>
                            <option value="STEP_UP">STEP_UP</option>
                            <option value="HOLD">HOLD</option>
                            <option value="BLOCK">BLOCK</option>
                        </Select>
                    </Field>
                    <Field label="Risk level">
                        <Select value={filters.riskLevel} onChange={(e) => setFilters({ ...filters, riskLevel: e.target.value })}>
                            <option value="">All</option>
                            <option value="LOW">LOW</option>
                            <option value="MEDIUM">MEDIUM</option>
                            <option value="HIGH">HIGH</option>
                            <option value="CRITICAL">CRITICAL</option>
                        </Select>
                    </Field>
                    <Field label="Status">
                        <Select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                            <option value="">All</option>
                            <option value="OPEN">OPEN</option>
                            <option value="UNDER_REVIEW">UNDER_REVIEW</option>
                            <option value="RESOLVED">RESOLVED</option>
                            <option value="DISMISSED">DISMISSED</option>
                        </Select>
                    </Field>
                    <Field label="Search" hint="Transaction or correlation id">
                        <TextInput
                            value={filters.search}
                            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                            placeholder="corr-…"
                        />
                    </Field>
                </div>
            </Card>

            {loading ? <Spinner label="Loading security events…" /> : (
                <ErrorNotice message={error} onRetry={load} />
            )}

            {!loading && (
                <Card title="Security events" subtitle={`${items.length} shown`}>
                    {items.length === 0 ? (
                        <EmptyState title="No events match" description="Adjust the filters or run a Fraud Lab scenario." />
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr className="text-xs uppercase tracking-wide text-slate-400">
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">When</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">Decision</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">Level</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">Score</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">Amount</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">Rules</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold">Status</th>
                                        <th className="whitespace-nowrap px-2 py-2 font-semibold" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map((item) => (
                                        <tr
                                            key={item.id}
                                            className={`border-t border-slate-800/70 ${item.id === selectedId ? 'bg-sky-950/20' : ''}`}
                                        >
                                            <td className="px-2 py-2 whitespace-nowrap text-slate-400">{formatDateTime(item.createdAt)}</td>
                                            <td className="px-2 py-2"><Badge value={item.decision} /></td>
                                            <td className="px-2 py-2"><Badge value={item.riskLevel} /></td>
                                            <td className="px-2 py-2 tabular-nums text-slate-300">{item.riskScore}</td>
                                            <td className="px-2 py-2 tabular-nums text-slate-300 whitespace-nowrap">{money(item.amountMinor)}</td>
                                            <td className="px-2 py-2 text-xs text-slate-400">{item.rules.join(', ') || '—'}</td>
                                            <td className="px-2 py-2"><Badge value={item.status} /></td>
                                            <td className="px-2 py-2 text-right">
                                                <Button variant="ghost" onClick={() => openDetail(item.id)}>Details</Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            )}

            {detail && (
                <Card
                    title="Event detail"
                    subtitle={detail.event.correlationId ? `correlation ${detail.event.correlationId}` : undefined}
                    actions={<Button variant="ghost" onClick={() => setDetail(null)}>Close</Button>}
                >
                    <div className="space-y-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge value={detail.event.decision} />
                            <Badge value={detail.event.riskLevel} />
                            <Badge value={detail.event.status} />
                            <span className="text-slate-400">score {detail.event.riskScore}</span>
                            <span className="text-slate-400">{money(detail.event.amountMinor)}</span>
                        </div>

                        <div>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Triggered rules</p>
                            <ul className="space-y-1.5">
                                {detail.event.rulesTriggered.map((rule) => (
                                    <li key={rule.rule} className="rounded-lg border border-slate-800 px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="font-mono text-xs text-amber-300">{rule.rule}</span>
                                            <span className="text-xs text-slate-400">+{rule.weight}</span>
                                        </div>
                                        <p className="mt-0.5 text-xs text-slate-300">{rule.explanation}</p>
                                    </li>
                                ))}
                                {detail.event.rulesTriggered.length === 0 && <li className="text-xs text-slate-400">No rules triggered.</li>}
                            </ul>
                        </div>

                        {detail.freezes.length > 0 && (
                            <div>
                                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Related freezes</p>
                                <ul className="space-y-1.5">
                                    {detail.freezes.map((freeze) => (
                                        <li key={freeze.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-300">
                                            <Badge value={freeze.status} />
                                            <span>{freeze.scope}</span>
                                            <span className="text-slate-400">{freeze.reason}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {['OPEN', 'UNDER_REVIEW'].includes(detail.event.status) && (
                            <div className="space-y-2 rounded-xl border border-slate-800 p-3">
                                <Field label="Review reason" hint="Recorded in the tamper-evident audit trail">
                                    <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain the decision…" />
                                </Field>
                                <div className="flex flex-wrap gap-2">
                                    <Button onClick={() => review('RELEASE')}>Release account</Button>
                                    <Button variant="secondary" onClick={() => review('CONFIRM')}>Confirm risk</Button>
                                    <Button variant="danger" onClick={() => review('ESCALATE')}>Escalate</Button>
                                </div>
                            </div>
                        )}
                    </div>
                </Card>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Incidents
 * ------------------------------------------------------------------ */

function Incidents({ incidentId, onSelect }) {
    const [items, setItems] = useState([]);
    const [timeline, setTimeline] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const loadList = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await endpoints.securityIncidents();
            const list = result?.data?.items || [];
            setItems(list);
            if (!incidentId && list.length) onSelect(list[0].id);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [incidentId, onSelect]);

    useEffect(() => { loadList(); }, [loadList]);

    useEffect(() => {
        if (!incidentId) return;
        let active = true;
        endpoints.securityIncident(incidentId)
            .then((result) => { if (active) setTimeline(result?.data || null); })
            .catch((err) => { if (active) setError(err.message); });
        return () => { active = false; };
    }, [incidentId]);

    if (loading && !items.length) return <Spinner label="Loading incidents…" />;

    return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr]">
            <Card title="Incidents" subtitle={`${items.length} total`}>
                <ErrorNotice message={error} onRetry={loadList} />
                {items.length === 0 ? (
                    <EmptyState title="No incidents" description="Incidents are opened automatically for high-risk activity." />
                ) : (
                    <ul className="space-y-2">
                        {items.map((incident) => (
                            <li key={incident.id}>
                                <button
                                    onClick={() => onSelect(incident.id)}
                                    className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                                        incident.id === incidentId
                                            ? 'border-sky-500/40 bg-sky-500/10'
                                            : 'border-slate-800 hover:border-slate-700 hover:bg-slate-900/40'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-sm text-slate-200">{incident.title}</span>
                                        <Badge value={incident.severity} />
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                                        <Badge value={incident.status} />
                                        <span>{incident.riskEventCount} event(s)</span>
                                    </div>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card
                title={timeline?.incident?.title || 'Incident details'}
                subtitle={timeline?.incident?.correlationId ? `correlation ${timeline.incident.correlationId}` : 'Select an incident'}
            >
                {!timeline ? (
                    <EmptyState title="No incident selected" description="Choose an incident to inspect its ordered timeline." />
                ) : (
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge value={timeline.incident.severity} />
                            <Badge value={timeline.incident.status} />
                            <span className="text-xs text-slate-400">{timeline.blockedActions} blocked action(s)</span>
                        </div>
                        {timeline.incident.description && (
                            <p className="whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
                                {timeline.incident.description}
                            </p>
                        )}
                        <ol className="relative space-y-3 border-l border-slate-800 pl-4">
                            {timeline.timeline.map((step, index) => (
                                <li key={`${step.at}-${index}`} className="relative">
                                    <span
                                        className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${
                                            step.blocked ? 'bg-rose-400' : 'bg-sky-400'
                                        }`}
                                    />
                                    <div className="rounded-xl border border-slate-800 px-3 py-2">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-sm text-slate-200">{step.title}</span>
                                            <span className="text-xs text-slate-400">{formatDateTime(step.at)}</span>
                                        </div>
                                        <p className="mt-0.5 text-xs text-slate-400">{step.type}</p>
                                        {step.detail && <p className="mt-1 text-xs text-slate-400">{step.detail}</p>}
                                        {step.blocked && <p className="mt-1 text-xs font-medium text-rose-300">Blocked</p>}
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </div>
                )}
            </Card>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Freezes
 * ------------------------------------------------------------------ */

function Freezes() {
    const toast = useToast();
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [reasons, setReasons] = useState({});

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await endpoints.securityFreezes();
            setItems(result?.data?.items || []);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const release = async (userId) => {
        const reason = (reasons[userId] || '').trim();
        if (reason.length < 3) {
            toast.error('A release reason is required.');
            return;
        }
        try {
            await endpoints.releaseFreeze(userId, { reason });
            toast.success('Freeze released.');
            setReasons({ ...reasons, [userId]: '' });
            await load();
        } catch (err) {
            toast.error(err.message);
        }
    };

    if (loading && !items.length) return <Spinner label="Loading freezes…" />;

    return (
        <Card title="Account freeze controls" subtitle="Requires administrator authorization and a documented reason">
            <ErrorNotice message={error} onRetry={load} />
            {items.length === 0 ? (
                <EmptyState title="No freezes" description="No account is currently restricted." />
            ) : (
                <div className="space-y-3">
                    {items.map((freeze) => (
                        <div key={freeze.id} className="rounded-xl border border-slate-800 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge value={freeze.status} />
                                    <span className="text-sm text-slate-200">
                                        {freeze.retailer?.fullName || `User #${freeze.userId}`}
                                    </span>
                                    <span className="text-xs text-slate-400">{freeze.scope}</span>
                                </div>
                                <span className="text-xs text-slate-400">{formatDateTime(freeze.frozenAt)}</span>
                            </div>
                            <p className="mt-1 text-xs text-slate-400">{freeze.reason}</p>
                            {freeze.status === 'ACTIVE' && (
                                <div className="mt-2 flex flex-wrap items-end gap-2">
                                    <div className="min-w-[16rem] flex-1">
                                        <TextInput
                                            value={reasons[freeze.userId] || ''}
                                            onChange={(e) => setReasons({ ...reasons, [freeze.userId]: e.target.value })}
                                            placeholder="Reason for releasing this freeze"
                                        />
                                    </div>
                                    <Button variant="secondary" onClick={() => release(freeze.userId)}>Release</Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

/* ------------------------------------------------------------------ *
 * Integrity
 * ------------------------------------------------------------------ */

function Integrity() {
    const [audit, setAudit] = useState(null);
    const [ledger, setLedger] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [auditResult, ledgerResult] = await Promise.all([
                endpoints.auditIntegrity(500),
                endpoints.ledgerIntegrity()
            ]);
            setAudit(auditResult?.data || null);
            setLedger(ledgerResult?.data || null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (loading) return <Spinner label="Verifying integrity…" />;

    return (
        <div className="space-y-4">
            <ErrorNotice message={error} onRetry={load} />
            <div className="flex gap-2">
                <Button variant="secondary" onClick={load}>Re-run checks</Button>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Audit chain" subtitle="Hash-chained, tamper-evident audit trail">
                    {!audit ? <EmptyState title="Unavailable" /> : (
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between"><span className="text-slate-400">Status</span><Badge value={audit.valid ? 'VALID' : 'INVALID'} /></div>
                            <div className="flex items-center justify-between"><span className="text-slate-400">Records verified</span><span className="tabular-nums text-slate-200">{formatNumber(audit.checked)}</span></div>
                            <div className="flex items-center justify-between"><span className="text-slate-400">Total chained records</span><span className="tabular-nums text-slate-200">{formatNumber(audit.totalChainedRecords)}</span></div>
                            {audit.tip && (
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-slate-400">Tip hash</span>
                                    <span className="truncate font-mono text-xs text-slate-400">{audit.tip.hash?.slice(0, 24)}…</span>
                                </div>
                            )}
                            {!audit.valid && audit.firstInvalidSequence != null && (
                                <p className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                                    First invalid record: sequence {audit.firstInvalidSequence} ({audit.reason}).
                                </p>
                            )}
                            <p className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs leading-relaxed text-slate-400">
                                {audit.limitation}
                            </p>
                        </div>
                    )}
                </Card>

                <Card title="Ledger invariants" subtitle="Debits must equal credits; balances must not be negative">
                    {!ledger ? <EmptyState title="Unavailable" /> : (
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between"><span className="text-slate-400">Status</span><Badge value={ledger.ok ? 'VALID' : 'INVALID'} /></div>
                            <div className="flex items-center justify-between"><span className="text-slate-400">Journals checked</span><span className="tabular-nums text-slate-200">{formatNumber(ledger.journalsChecked)}</span></div>
                            <div className="flex items-center justify-between"><span className="text-slate-400">Entries checked</span><span className="tabular-nums text-slate-200">{formatNumber(ledger.entriesChecked)}</span></div>
                            <div className="flex items-center justify-between"><span className="text-slate-400">Total debits</span><span className="tabular-nums text-slate-200">{money(ledger.totalDebitMinor)}</span></div>
                            <div className="flex items-center justify-between"><span className="text-slate-400">Total credits</span><span className="tabular-nums text-slate-200">{money(ledger.totalCreditMinor)}</span></div>
                            {ledger.unbalancedJournals?.length > 0 && (
                                <p className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                                    {ledger.unbalancedJournals.length} unbalanced journal(s) detected.
                                </p>
                            )}
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function SecurityCenter() {
    const [tab, setTab] = useState('overview');
    const [incidentId, setIncidentId] = useState(null);
    const [selectedEventId, setSelectedEventId] = useState(null);

    const openIncident = (id) => {
        setIncidentId(id);
        setTab('incidents');
    };

    return (
        <div className="space-y-5">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Security Center</h1>
                    <p className="mt-1 text-sm text-slate-400">
                        Fraud detection, holds, tenant isolation, ledger integrity and incident response.
                    </p>
                </div>
                <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-inset ring-amber-500/30">
                    Sandbox · simulated data
                </span>
            </header>

            <nav className="flex flex-wrap gap-1.5" aria-label="Security Center sections">
                {TABS.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => setTab(item.id)}
                        aria-current={tab === item.id ? 'page' : undefined}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                            tab === item.id
                                ? 'bg-sky-500/15 text-sky-200 ring-1 ring-inset ring-sky-500/30'
                                : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                        }`}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>

            {tab === 'overview' && <Overview onOpenIncident={openIncident} />}
            {tab === 'events' && <EventExplorer selectedId={selectedEventId} onSelected={setSelectedEventId} />}
            {tab === 'incidents' && <Incidents incidentId={incidentId} onSelect={setIncidentId} />}
            {tab === 'freezes' && <Freezes />}
            {tab === 'integrity' && <Integrity />}
        </div>
    );
}
