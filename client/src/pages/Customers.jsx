import { useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, EmptyState, ErrorNotice, Spinner, TextInput } from '../components/ui.jsx';
import { formatCurrency, formatDateTime, formatTime } from '../lib/format.js';

function ModuleNotice({ title, module }) {
    return (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <p className="text-xs font-medium text-slate-300">{title}</p>
            <p className="mt-1 text-[11px] text-slate-500">
                {module?.implemented === false ? 'Not implemented yet — scheduled for a later phase.' : 'No records.'}
            </p>
        </div>
    );
}

export default function Customers() {
    const [uuid, setUuid] = useState('');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const onSubmit = async (event) => {
        event.preventDefault();
        if (!uuid.trim()) return;

        setLoading(true);
        setError(null);
        try {
            const response = await endpoints.customerOverview(uuid.trim());
            setData(response.data);
        } catch (err) {
            setData(null);
            setError(err.message || 'Failed to load customer.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-5">
            <div>
                <h1 className="text-lg font-semibold text-slate-100">Customer 360</h1>
                <p className="text-xs text-slate-500">One view of a customer: profile, KYC, payments, risk signals and timeline</p>
            </div>

            <Card title="Look up a customer" subtitle="Paste the customer UUID from the KYC or onboarding module">
                <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
                    <TextInput
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={uuid}
                        onChange={(e) => setUuid(e.target.value)}
                        className="font-mono"
                    />
                    <Button type="submit" disabled={loading || !uuid.trim()} className="sm:w-40">
                        {loading ? 'Loading…' : 'Load overview'}
                    </Button>
                </form>
            </Card>

            <ErrorNotice message={error} />

            {loading && !data && <Spinner label="Building customer overview…" />}

            {data && (
                <div className="space-y-4">
                    <Card title="Profile" subtitle="Identity and business information">
                        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                            {[
                                ['Name', data.profile.fullName],
                                ['Email', data.profile.email],
                                ['Mobile', data.profile.mobile],
                                ['Role', data.profile.role],
                                ['Company', data.profile.companyName || '—'],
                                ['Business type', data.profile.businessType || '—'],
                                ['Blocked', data.profile.isBlocked ? 'Yes' : 'No'],
                                ['Joined', formatDateTime(data.profile.createdAt)]
                            ].map(([label, value]) => (
                                <div key={label} className="rounded-lg bg-slate-900/60 p-3">
                                    <p className="text-slate-500">{label}</p>
                                    <p className="mt-1 truncate font-medium text-slate-200">{value ?? '—'}</p>
                                </div>
                            ))}
                        </div>
                    </Card>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card title="KYC" subtitle="Verification state">
                            <div className="flex items-center gap-3">
                                <Badge value={data.kyc.status || 'Pending'} />
                                <span className="text-xs text-slate-400">Step {data.kyc.step ?? 0} · {data.kyc.category || '—'}</span>
                            </div>
                            {data.kyc.rejectionReason && (
                                <p className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                                    {data.kyc.rejectionReason}
                                </p>
                            )}
                            <p className="mt-3 text-[11px] text-slate-500">
                                KYC journey timeline: {data.kyc.journeyImplemented ? 'available' : 'planned for a later phase'}
                            </p>
                        </Card>

                        <Card title="Risk signals" subtitle="Derived from account state and payment history">
                            {data.riskSignals.length === 0 ? (
                                <EmptyState title="No risk signals" description="The customer looks clean on the checks currently implemented." />
                            ) : (
                                <ul className="space-y-2">
                                    {data.riskSignals.map((signal) => (
                                        <li key={signal.code} className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-2 text-xs">
                                            <span className="font-medium text-slate-200">{signal.code}</span>
                                            <Badge value={signal.severity === 'HIGH' ? 'FAILED' : signal.severity === 'MEDIUM' ? 'PENDING' : 'CREATED'} />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card title="Bank accounts" subtitle="Masked by design">
                            {data.bankAccounts.length === 0 ? (
                                <EmptyState title="No bank account on file" />
                            ) : (
                                <ul className="space-y-2 text-xs">
                                    {data.bankAccounts.map((account, index) => (
                                        <li key={index} className="rounded-lg bg-slate-900/60 p-3">
                                            <p className="font-medium text-slate-200">{account.bankName || '—'}</p>
                                            <p className="mt-1 text-slate-400">{account.accountHolderName} · {account.accountNumberMasked}</p>
                                            <p className="text-slate-500">{account.ifscCode} · {account.branchName}</p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        <Card title="Counts" subtitle="Records linked to this customer">
                            <div className="grid grid-cols-3 gap-3 text-center text-xs">
                                <div className="rounded-lg bg-slate-900/60 p-3">
                                    <p className="text-slate-500">Orders</p>
                                    <p className="mt-1 text-lg font-semibold text-slate-100">{data.counts.orders}</p>
                                </div>
                                <div className="rounded-lg bg-slate-900/60 p-3">
                                    <p className="text-slate-500">Payments</p>
                                    <p className="mt-1 text-lg font-semibold text-slate-100">{data.counts.payments}</p>
                                </div>
                                <div className="rounded-lg bg-slate-900/60 p-3">
                                    <p className="text-slate-500">Refunds</p>
                                    <p className="mt-1 text-lg font-semibold text-slate-100">{data.counts.refunds}</p>
                                </div>
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-3">
                                <ModuleNotice title="Payouts" module={data.payouts} />
                                <ModuleNotice title="Bills" module={data.bills} />
                                <ModuleNotice title="Support tickets" module={data.supportTickets} />
                            </div>
                        </Card>
                    </div>

                    <Card title="Payments" subtitle="Most recent 50">
                        {data.payments.length === 0 ? (
                            <EmptyState title="No payments for this customer" />
                        ) : (
                            <div className="-mx-4 overflow-x-auto sm:mx-0">
                                <table className="w-full min-w-[520px] text-left text-sm">
                                    <thead>
                                        <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                                            <th className="px-3 py-2 font-medium">Date</th>
                                            <th className="px-3 py-2 font-medium">Amount</th>
                                            <th className="px-3 py-2 font-medium">Method</th>
                                            <th className="px-3 py-2 font-medium">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.payments.map((payment) => (
                                            <tr key={payment.paymentId} className="border-b border-slate-900/70 last:border-0">
                                                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{formatDateTime(payment.createdAt)}</td>
                                                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-200">{formatCurrency(payment.amount, payment.currency)}</td>
                                                <td className="px-3 py-2 text-xs text-slate-400">{payment.method}</td>
                                                <td className="px-3 py-2"><Badge value={payment.status} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>

                    <Card title="Timeline" subtitle="Most recent 50 events">
                        {data.timeline.length === 0 ? (
                            <EmptyState title="No events recorded" />
                        ) : (
                            <ol className="space-y-3 border-l border-slate-800 pl-5">
                                {data.timeline.map((event, index) => (
                                    <li key={index} className="relative text-xs">
                                        <span className="absolute -left-[23px] top-1.5 h-2 w-2 rounded-full bg-sky-500" />
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-semibold text-slate-200">{event.event}</span>
                                            <span className="tabular-nums text-slate-500">{formatTime(event.at)}</span>
                                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">{event.source}</span>
                                        </div>
                                        {event.message && <p className="mt-1 text-slate-400">{event.message}</p>}
                                    </li>
                                ))}
                            </ol>
                        )}
                    </Card>
                </div>
            )}
        </div>
    );
}
