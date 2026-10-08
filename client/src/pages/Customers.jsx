import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Select, Spinner, TextInput } from '../components/ui.jsx';
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

function ProfileEntry({ label, value, mono }) {
    return (
        <div className="rounded-lg bg-slate-900/60 p-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className={`mt-1 break-words font-medium text-slate-200 ${mono ? 'font-mono text-[11px]' : ''}`}>
                {value === null || value === undefined || value === '' ? '—' : String(value)}
            </p>
        </div>
    );
}

export default function Customers() {
    const toast = useToast();
    const [directory, setDirectory] = useState([]);
    const [directoryLoading, setDirectoryLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [uuid, setUuid] = useState('');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setDirectoryLoading(true);
            try {
                const response = await endpoints.customerList();
                if (!cancelled) setDirectory(response.data?.customers || []);
            } catch (err) {
                if (!cancelled) setError(err.message || 'Failed to load the customer directory.');
            } finally {
                if (!cancelled) setDirectoryLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return directory;
        return directory.filter((c) =>
            [c.fullName, c.email, c.mobile, c.uuid, c.company_name]
                .filter(Boolean)
                .some((value) => String(value).toLowerCase().includes(term))
        );
    }, [directory, search]);

    const loadByUuid = async (targetUuid) => {
        if (!targetUuid.trim()) return;
        setLoading(true);
        setError(null);
        setCopied(false);
        try {
            const response = await endpoints.customerOverview(targetUuid.trim());
            setData(response.data);
        } catch (err) {
            setData(null);
            setError(err.message || 'Failed to load customer.');
            toast.error(err.message || 'Failed to load customer.');
        } finally {
            setLoading(false);
        }
    };

    const onSubmit = async (event) => {
        event.preventDefault();
        await loadByUuid(uuid);
    };

    const onSelectDirectoryEntry = (event) => {
        const value = event.target.value;
        setUuid(value);
        if (value) loadByUuid(value);
    };

    const copyUuid = async () => {
        try {
            await navigator.clipboard.writeText(data.profile.uuid);
            setCopied(true);
            toast.success('Customer UUID copied to clipboard.');
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error('Clipboard unavailable — copy the UUID manually.');
        }
    };

    const p = data?.profile;

    return (
        <div className="space-y-5">
            <div>
                <h1 className="text-lg font-semibold text-slate-100">Customer 360</h1>
                <p className="text-xs text-slate-500">One view of a customer: full profile, KYC journey, payments, risk signals and timeline</p>
            </div>

            <Card title="Look up a customer" subtitle="Pick from the directory or paste a customer UUID">
                <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Customer directory">
                            <Select value={uuid} onChange={onSelectDirectoryEntry} disabled={directoryLoading}>
                                <option value="">
                                    {directoryLoading ? 'Loading customers…' : `Select a customer (${directory.length})`}
                                </option>
                                {filtered.map((customer) => (
                                    <option key={customer.uuid} value={customer.uuid}>
                                        {customer.fullName} · {customer.mobile} · {customer.kyc}
                                    </option>
                                ))}
                            </Select>
                        </Field>
                        <Field label="Search directory" hint="Filters by name, email, phone or UUID">
                            <TextInput
                                placeholder="Search customers…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </Field>
                    </div>

                    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
                        <TextInput
                            placeholder="00000000-0000-0000-0000-000000000000"
                            value={uuid}
                            onChange={(e) => setUuid(e.target.value)}
                            className="font-mono"
                        />
                        <Button type="submit" disabled={loading || !uuid.trim()} className="sm:w-44">
                            {loading ? 'Loading…' : 'Load overview'}
                        </Button>
                    </form>
                </div>
            </Card>

            <ErrorNotice message={error} />

            {loading && !data && <Spinner label="Building customer overview…" />}

            {data && p && (
                <div className="space-y-4">
                    <Card
                        title="Profile"
                        subtitle="Identity and business information"
                        actions={
                            <div className="flex items-center gap-2">
                                <Badge value={data.kyc.status || 'Pending'} />
                                <Button type="button" variant="secondary" className="!px-2.5 !py-1 !text-xs" onClick={copyUuid}>
                                    {copied ? 'UUID copied ✓' : 'Copy UUID'}
                                </Button>
                            </div>
                        }
                    >
                        <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-slate-500">Customer UUID</p>
                            <p className="mt-0.5 break-all font-mono text-xs text-sky-300">{p.uuid}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                            {[
                                ['Name', p.fullName],
                                ['Email', p.email],
                                ['Mobile', p.mobile],
                                ['Date of birth', p.dob],
                                ['Role', p.role],
                                ['Shop name', p.shopname],
                                ['Company', p.companyName],
                                ['Business type', p.businessType],
                                ['Business category', p.businessCategory],
                                ['CIN', p.cin],
                                ['GST number', p.gstNumber],
                                ['PAN', p.pan],
                                ['PAN status', p.panStatus],
                                ['Address', p.address],
                                ['City', p.city],
                                ['State', p.state],
                                ['Pincode', p.pincode],
                                ['Business address', p.businessAddress],
                                ['Registered address', p.registeredAddress],
                                ['PEP status', p.pepStatus],
                                ['DigiLocker', p.digilockerRegistered ? 'Registered' : 'Not registered'],
                                ['Selfie on file', p.hasSelfie ? 'Yes' : 'No'],
                                ['Video KYC', p.hasVideoKyc ? 'Yes' : 'No'],
                                ['Blocked', p.isBlocked ? 'Yes' : 'No'],
                                ['Joined', formatDateTime(p.createdAt)],
                                ['Last updated', formatDateTime(p.updatedAt)]
                            ].map(([label, value]) => (
                                <ProfileEntry key={label} label={label} value={value} />
                            ))}
                        </div>
                    </Card>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card title="KYC" subtitle="Verification state and journey">
                            <div className="flex flex-wrap items-center gap-3">
                                <Badge value={data.kyc.status || 'Pending'} />
                                <span className="text-xs text-slate-400">Step {data.kyc.step ?? 0} · {data.kyc.category || '—'}</span>
                                <span className="text-xs font-medium text-slate-300">
                                    {data.kyc.completionPercent ?? 0}% complete ({data.kyc.completed ?? 0}/{data.kyc.total ?? 0})
                                </span>
                                <span className={`text-[11px] font-semibold ${data.kyc.verified ? 'text-emerald-300' : 'text-amber-300'}`}>
                                    {data.kyc.verified ? 'All required steps complete' : 'Incomplete'}
                                </span>
                            </div>

                            {data.kyc.rejectionReason && (
                                <p className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                                    {data.kyc.rejectionReason}
                                </p>
                            )}

                            {data.kyc.blockers?.length > 0 && (
                                <div className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
                                    <p className="font-semibold">Blockers</p>
                                    <ul className="list-disc pl-4">
                                        {data.kyc.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
                                    </ul>
                                </div>
                            )}

                            {data.kyc.missing?.length > 0 && (
                                <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                                    <p className="font-semibold">Missing</p>
                                    <ul className="list-disc pl-4">
                                        {data.kyc.missing.map((item, index) => <li key={index}>{item}</li>)}
                                    </ul>
                                </div>
                            )}

                            {data.kyc.timeline?.length > 0 && (
                                <ul className="mt-3 space-y-1.5">
                                    {data.kyc.timeline.map((step) => (
                                        <li key={step.key} className="flex items-start justify-between gap-3 text-[11px]">
                                            <div>
                                                <p className="text-slate-300">{step.label}</p>
                                                <p className="text-slate-500">{step.detail}</p>
                                            </div>
                                            <Badge value={step.status} />
                                        </li>
                                    ))}
                                </ul>
                            )}
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
                                            <p className="text-slate-400">{account.accountHolderName} · {account.accountNumberMasked}</p>
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
