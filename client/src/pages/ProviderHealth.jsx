import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Card, EmptyState, ErrorNotice, Spinner, StatCard } from '../components/ui.jsx';
import { formatNumber, formatSeconds, percent } from '../lib/format.js';

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
                <p className="text-xs text-slate-500">
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

                            <div className="mt-4 space-y-1.5 text-xs text-slate-500">
                                <p>Integrated: {provider.integrated ? 'Yes' : 'No'} · Enabled: {provider.enabled ? 'Yes' : 'No'}</p>
                                <p>Refunds: {provider.supportsRefunds ? 'Supported' : 'Not supported'} · Pre-auth: {provider.supportsPreAuth ? 'Supported' : 'Not supported'}</p>
                                <p>Latency measurement: {provider.metrics.latencyMs === null ? 'not yet instrumented (Phase 2)' : `${provider.metrics.latencyMs} ms`}</p>
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            <Card title="Smart Provider Routing" subtitle="Planned for the next phase">
                <p className="text-xs text-slate-400">
                    The capability registry that will back routing (methods, countries, currencies per provider) is already in place.
                    The router itself — health-aware selection and the rule that a payment is never blindly failed over while its
                    outcome is unknown — is Phase 2 work.
                </p>
            </Card>
        </div>
    );
}
