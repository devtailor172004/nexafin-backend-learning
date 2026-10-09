import { useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime } from '../lib/format.js';
import {
    Badge,
    Button,
    Card,
    EmptyState,
    ErrorNotice,
    Field,
    Spinner,
    TextInput
} from '../components/ui.jsx';

/**
 * Fraud Lab — safe, repeatable security scenarios.
 *
 * The result panel is driven entirely by the backend report. A scenario is only
 * marked as passed when the backend verified the underlying security and
 * business invariants — never because a request merely returned HTTP 200.
 */

function ScenarioResult({ report }) {
    return (
        <Card
            title={`Scenario ${report.scenario} — ${report.passed ? 'Passed' : 'Failed'}`}
            subtitle={`${report.name} · ran in ${report.durationMs ?? 0} ms`}
            actions={<Badge value={report.passed ? 'PASSED' : 'FAILED'} />}
        >
            <div className="space-y-4 text-sm">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-slate-800 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">What this tests</p>
                        <p className="mt-1 text-xs text-slate-300">{report.whatItTests}</p>
                    </div>
                    <div className="rounded-xl border border-slate-800 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Expected</p>
                        <p className="mt-1 text-xs text-slate-300">{report.expected}</p>
                    </div>
                </div>

                <div className="rounded-xl border border-slate-800 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Actual result</p>
                    <p className="mt-1 text-xs text-slate-300">{report.actual}</p>
                    {report.error && <p className="mt-1 text-xs text-rose-300">{report.error}</p>}
                </div>

                <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Steps</p>
                    <ol className="space-y-1.5">
                        {(report.steps || []).map((step, index) => (
                            <li key={`${step.name}-${index}`} className="flex items-start gap-2 rounded-lg border border-slate-800 px-3 py-2">
                                <span className={`mt-0.5 text-xs ${step.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {step.ok ? '✔' : '✘'}
                                </span>
                                <div className="min-w-0">
                                    <p className="text-xs font-medium text-slate-200">{step.name}</p>
                                    <p className="text-xs text-slate-400">{step.detail}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {report.riskScore !== undefined && (
                        <div className="rounded-xl border border-slate-800 p-3">
                            <p className="text-xs uppercase tracking-wide text-slate-400">Risk score</p>
                            <p className="mt-0.5 text-lg tabular-nums text-slate-100">{report.riskScore}</p>
                        </div>
                    )}
                    {report.decision && (
                        <div className="rounded-xl border border-slate-800 p-3">
                            <p className="text-xs uppercase tracking-wide text-slate-400">Decision</p>
                            <div className="mt-1"><Badge value={report.decision} /></div>
                        </div>
                    )}
                    {report.ledgerChanged !== undefined && (
                        <div className="rounded-xl border border-slate-800 p-3">
                            <p className="text-xs uppercase tracking-wide text-slate-400">Ledger changed</p>
                            <p className="mt-0.5 text-sm text-slate-100">{report.ledgerChanged ? 'Yes' : 'No'}</p>
                        </div>
                    )}
                    {report.rulesTriggered?.length > 0 && (
                        <div className="rounded-xl border border-slate-800 p-3">
                            <p className="text-xs uppercase tracking-wide text-slate-400">Rules</p>
                            <p className="mt-0.5 text-xs text-amber-300">{report.rulesTriggered.join(', ')}</p>
                        </div>
                    )}
                </div>

                {(report.riskEventId || report.incidentId || report.correlationId) && (
                    <div className="flex flex-wrap gap-3 text-xs text-slate-400">
                        {report.riskEventId && <span>risk event: <span className="font-mono">{report.riskEventId}</span></span>}
                        {report.incidentId && <span>incident: <span className="font-mono">{report.incidentId}</span></span>}
                        {report.correlationId && <span>correlation: <span className="font-mono">{report.correlationId}</span></span>}
                    </div>
                )}
            </div>
        </Card>
    );
}

export default function FraudLab() {
    const toast = useToast();
    const [scenarios, setScenarios] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState('A');
    const [burst, setBurst] = useState('8');
    const [concurrency, setConcurrency] = useState('10');
    const [running, setRunning] = useState(false);
    const [report, setReport] = useState(null);
    const [history, setHistory] = useState([]);

    useEffect(() => {
        let active = true;
        endpoints.fraudLabScenarios()
            .then((result) => { if (active) setScenarios(result?.data?.scenarios || []); })
            .catch((err) => { if (active) setError(err.message); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    const current = scenarios.find((s) => s.id === selected);

    const run = async () => {
        setRunning(true);
        setError('');
        try {
            const body = {};
            if (selected === 'B') body.burst = Number(burst) || undefined;
            if (selected === 'F') body.concurrency = Number(concurrency) || undefined;

            const result = await endpoints.runFraudLabScenario(selected, body);
            const next = result?.data || null;
            setReport(next);
            if (next) {
                setHistory((prev) => [{ ...next, at: new Date().toISOString() }, ...prev].slice(0, 8));
                if (next.passed) toast.success(`Scenario ${next.scenario} passed.`);
                else toast.error(`Scenario ${next.scenario} reported findings.`);
            }
        } catch (err) {
            setError(err.message);
            toast.error(err.message);
        } finally {
            setRunning(false);
        }
    };

    if (loading) return <Spinner label="Loading Fraud Lab…" />;

    return (
        <div className="space-y-5">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold text-slate-100">Fraud Lab</h1>
                    <p className="text-xs text-slate-400">
                        Run safe, repeatable security scenarios against synthetic sandbox retailers.
                    </p>
                </div>
                <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-inset ring-amber-500/30">
                    Sandbox
                </span>
            </header>

            <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
                Every financial operation here is <strong>simulated</strong> against synthetic sandbox data. No real
                payments, payouts or retailer accounts are involved, and the lab is refused when the server runs in
                production.
            </div>

            <ErrorNotice message={error} />

            <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
                <Card title="Scenarios" subtitle="Select one to run">
                    <ul className="space-y-2">
                        {scenarios.map((scenario) => (
                            <li key={scenario.id}>
                                <button
                                    onClick={() => { setSelected(scenario.id); setReport(null); }}
                                    aria-current={selected === scenario.id ? 'true' : undefined}
                                    className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                                        selected === scenario.id
                                            ? 'border-sky-500/40 bg-sky-500/10'
                                            : 'border-slate-800 hover:border-slate-700 hover:bg-slate-900/40'
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-xs text-sky-300">{scenario.id}</span>
                                        <span className="text-sm text-slate-200">{scenario.name}</span>
                                    </div>
                                    <p className="mt-0.5 text-xs text-slate-400">{scenario.description}</p>
                                </button>
                            </li>
                        ))}
                    </ul>
                </Card>

                <div className="space-y-4">
                    <Card
                        title={current ? `Run scenario ${current.id}` : 'Run scenario'}
                        subtitle={current?.whatItTests}
                    >
                        <div className="space-y-3">
                            {selected === 'B' && (
                                <Field label="Burst size" hint="Number of rapid simulated payouts (default 8)">
                                    <TextInput value={burst} onChange={(e) => setBurst(e.target.value)} inputMode="numeric" />
                                </Field>
                            )}
                            {selected === 'F' && (
                                <Field label="Concurrency" hint="Simultaneous debits against the sandbox wallet (2–25)">
                                    <TextInput value={concurrency} onChange={(e) => setConcurrency(e.target.value)} inputMode="numeric" />
                                </Field>
                            )}

                            {current && (
                                <div className="rounded-xl border border-slate-800 p-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Expected result</p>
                                    <p className="mt-1 text-xs text-slate-300">{current.expected}</p>
                                </div>
                            )}

                            <Button onClick={run} disabled={running}>
                                {running ? 'Running…' : 'Run scenario'}
                            </Button>
                        </div>
                    </Card>

                    {report ? (
                        <ScenarioResult report={report} />
                    ) : (
                        <Card title="Result">
                            <EmptyState title="No result yet" description="Run a scenario to see what was tested, the actual outcome and whether it passed." />
                        </Card>
                    )}

                    {history.length > 1 && (
                        <Card title="Recent runs" subtitle="This session">
                            <ul className="space-y-1.5 text-xs">
                                {history.map((run, index) => (
                                    <li key={`${run.scenario}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 px-3 py-1.5">
                                        <span className="text-slate-300">
                                            <span className="font-mono text-sky-300">{run.scenario}</span> {run.name}
                                        </span>
                                        <span className="flex items-center gap-2">
                                            <span className="text-slate-400">{formatDateTime(run.at)}</span>
                                            <Badge value={run.passed ? 'PASSED' : 'FAILED'} />
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
