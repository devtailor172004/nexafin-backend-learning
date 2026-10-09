import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Select, Spinner, StatCard } from '../components/ui.jsx';
import { formatNumber, formatSeconds, percent } from '../lib/format.js';

const METHODS = ['', 'UPI', 'CARD', 'NETBANKING'];
const CURRENCIES = ['', 'INR', 'USD', 'GBP', 'AED', 'SGD'];
const COUNTRIES = ['', 'IN', 'US', 'GB', 'AE', 'SG'];

function RoutingPreview() {
    const [method, setMethod] = useState('UPI');
    const [currency, setCurrency] = useState('INR');
    const [country, setCountry] = useState('IN');
    const [decision, setDecision] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const preview = async () => {
        setBusy(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (method) params.set('method', method);
            if (currency) params.set('currency', currency);
            if (country) params.set('country', country);

            const response = await endpoints.routingPreview(`?${params.toString()}`);
            setDecision(response.data.decision);
        } catch (err) {
            setError(err.message || 'Failed to preview routing.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card title="Smart Provider Routing" subtitle="Preview which provider the router would select">
            <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Method">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                        {METHODS.map((value) => <option key={value || 'any'} value={value}>{value || 'Any'}</option>)}
                    </Select>
                </Field>
                <Field label="Currency">
                    <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                        {CURRENCIES.map((value) => <option key={value || 'any'} value={value}>{value || 'Any'}</option>)}
                    </Select>
                </Field>
                <Field label="Country">
                    <Select value={country} onChange={(e) => setCountry(e.target.value)}>
                        {COUNTRIES.map((value) => <option key={value || 'any'} value={value}>{value || 'Any'}</option>)}
                    </Select>
                </Field>
                <div className="flex items-end">
                    <Button onClick={preview} disabled={busy} className="w-full">{busy ? 'Checking…' : 'Preview route'}</Button>
                </div>
            </div>

            <ErrorNotice message={error} />

            {decision && (
                <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                    {decision.selected ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-wider text-slate-400">Selected provider</p>
                                <p className="mt-0.5 text-sm font-semibold text-slate-100">{decision.selected.displayName}</p>
                                <p className="mt-0.5 text-xs text-slate-400">
                                    {decision.selected.methods.join(', ')} · {decision.selected.currencies.join(', ')}
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                <Badge value={decision.selected.health} />
                                <span className="text-xs text-slate-400">{percent(decision.selected.successRate)} success</span>
                            </div>
                        </div>
                    ) : (
                        <p className="text-xs text-amber-300">
                            No eligible provider ({decision.reason}). No payment method/currency/country combination is
                            integrated for this requirement, so the router refuses rather than guessing.
                        </p>
                    )}
                </div>
            )}

            <p className="mt-3 text-xs text-slate-400">
                Failover policy: a payment is never moved to another provider while its outcome is unknown —
                the status must be checked first. Only terminally failed payments may be retried elsewhere.
            </p>
        </Card>
    );
}

export default function ProviderHealth() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        try {
            const response = await endpoints.providerHealth();
            setData(response.data);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load provider health.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const timer = setInterval(load, 30000);
        return () => clearInterval(timer);
    }, [load]);

    if (loading && !data) return <Spinner label="Loading provider health…" />;

    const providers = data?.providers || [];

    return (
        <div className="space-y-5">
            <div>
                <h1 className="text-lg font-semibold text-slate-100">Provider Health</h1>
                <p className="text-xs text-slate-400">
                    24-hour rolling window · generated {data?.generatedAt ? new Date(data.generatedAt).toLocaleString('en-IN') : '—'}
                </p>
            </div>

            <ErrorNotice message={error} onRetry={load} />

            {providers.length === 0 ? (
                <EmptyState title="No providers registered" />
            ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                    {providers.map((provider) => (
                        <Card
                            key={provider.code}
                            title={provider.displayName}
                            subtitle={`${provider.code} · ${provider.methods.join(', ') || 'no methods'} · ${provider.currencies.join(', ')}`}
                            actions={<Badge value={provider.status} />}
                        >
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                <StatCard label="Transactions" value={formatNumber(provider.metrics.transactions)} />
                                <StatCard
                                    label="Success"
                                    value={percent(provider.metrics.successRate)}
                                    tone={provider.metrics.successRate >= 95 ? 'good' : provider.metrics.transactions ? 'warn' : 'default'}
                                />
                                <StatCard label="Failed" value={formatNumber(provider.metrics.failed)} tone={provider.metrics.failed ? 'bad' : 'default'} />
                                <StatCard label="Webhook delay" value={formatSeconds(provider.metrics.avgWebhookDelaySeconds)} tone="info" />
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                                <StatCard
                                    label="Avg latency"
                                    value={provider.metrics.latencyMs === null ? '—' : `${provider.metrics.latencyMs} ms`}
                                    hint={provider.metrics.latencyMs === null ? 'no calls yet' : undefined}
                                    tone="info"
                                />
                                <StatCard
                                    label="p95 latency"
                                    value={provider.metrics.latencyP95Ms === null ? '—' : `${provider.metrics.latencyP95Ms} ms`}
                                />
                                <StatCard label="Samples" value={formatNumber(provider.metrics.latencySamples)} hint="rolling window" />
                                <StatCard
                                    label="Call error rate"
                                    value={provider.metrics.providerErrorRate === null ? '—' : percent(provider.metrics.providerErrorRate)}
                                    tone={provider.metrics.providerErrorRate ? 'warn' : 'default'}
                                />
                            </div>

                            <div className="mt-4 space-y-1.5 text-xs text-slate-400">
                                <p>Integrated: {provider.integrated ? 'Yes' : 'No'} · Enabled: {provider.enabled ? 'Yes' : 'No'}</p>
                                <p>Refunds: {provider.supportsRefunds ? 'Supported' : 'Not supported'} · Pre-auth: {provider.supportsPreAuth ? 'Supported' : 'Not supported'}</p>
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            <RoutingPreview />
        </div>
    );
}
