import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Select, Spinner, TextInput } from '../components/ui.jsx';
import DetailGrid from '../components/DetailGrid.jsx';
import LivenessCheck from '../components/LivenessCheck.jsx';
import { formatDateTime } from '../lib/format.js';

const TABS = ['Details', 'Journey', 'Liveness'];

/**
 * KYC Verification workspace.
 *
 * Pick a customer from the directory, inspect their full KYC profile, walk the
 * journey, run a camera liveness test and record the admin decision — all in
 * one screen (the KYC Review page keeps the queue-style workflow).
 */
export default function KycVerification() {
    const toast = useToast();

    const [directory, setDirectory] = useState([]);
    const [directoryLoading, setDirectoryLoading] = useState(true);
    const [search, setSearch] = useState('');

    const [uuid, setUuid] = useState('');
    const [journey, setJourney] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('Details');

    const [decision, setDecision] = useState('Approved');
    const [reason, setReason] = useState('');
    const [privatePassword, setPrivatePassword] = useState('');
    const [saving, setSaving] = useState(false);
    const [docSaving, setDocSaving] = useState(null);

    const [passwordMissing, setPasswordMissing] = useState(false);
    const [newPrivatePassword, setNewPrivatePassword] = useState('');
    const [settingPassword, setSettingPassword] = useState(false);

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

    const loadCustomer = async (targetUuid, { silent = false } = {}) => {
        if (!targetUuid?.trim()) return;
        if (!silent) setLoading(true);
        setError(null);
        try {
            const response = await endpoints.kycJourney(targetUuid.trim());
            setJourney(response.data);
            setUuid(targetUuid.trim());
            return response.data;
        } catch (err) {
            setJourney(null);
            setError(err.message || 'Failed to load the KYC journey.');
            return null;
        } finally {
            if (!silent) setLoading(false);
        }
    };

    const onSelectDirectoryEntry = async (event) => {
        const value = event.target.value;
        if (!value) return;
        setTab('Details');
        await loadCustomer(value);
    };

    const handleKycError = (err, fallback) => {
        const message = err.message || fallback;
        setError(message);
        if (message.includes('has not been set')) {
            setPasswordMissing(true);
            toast.error('KYC private password is not set yet — set it below, then retry.');
        } else {
            toast.error(message);
        }
    };

    const savePrivatePassword = async () => {
        setSettingPassword(true);
        try {
            await endpoints.setKycPrivatePassword(newPrivatePassword);
            setPrivatePassword(newPrivatePassword);
            setPasswordMissing(false);
            setNewPrivatePassword('');
            toast.success('KYC private password set — retry the action.');
        } catch (err) {
            toast.error(err.message || 'Failed to set the private password.');
        } finally {
            setSettingPassword(false);
        }
    };

    const submitDecision = async (event) => {
        event.preventDefault();
        if (!uuid) return;
        setSaving(true);
        setError(null);
        try {
            await endpoints.kycApprove(uuid, {
                status: decision.toLowerCase(),
                reason,
                private_password: privatePassword
            });
            toast.success(`KYC marked as ${decision}.`);
            setPrivatePassword('');
            setReason('');
            await loadCustomer(uuid, { silent: true });
            const refreshed = await endpoints.customerList();
            setDirectory(refreshed.data?.customers || []);
        } catch (err) {
            handleKycError(err, 'Failed to update KYC status.');
        } finally {
            setSaving(false);
        }
    };

    const reviewDocument = async (documentUuid, nextStatus) => {
        if (!uuid) return;
        setDocSaving(documentUuid);
        setError(null);
        try {
            const response = await endpoints.kycReviewDocument(uuid, documentUuid, {
                status: nextStatus,
                reason: nextStatus === 'rejected' ? (reason || 'Rejected by admin') : undefined,
                private_password: privatePassword
            });
            setJourney((prev) => (prev ? { ...prev, ...response.data?.journey } : prev));
            toast.success(`Document marked as ${nextStatus}.`);
        } catch (err) {
            handleKycError(err, 'Failed to update the document.');
        } finally {
            setDocSaving(null);
        }
    };

    const saveLiveness = async (result) => {
        if (!uuid) return;
        try {
            const response = await endpoints.kycLiveness(uuid, {
                selfie: result.selfie,
                passed: result.passed,
                score: result.score,
                challenge: result.challenge,
                captureMs: result.captureMs
            });
            setJourney((prev) => (prev ? { ...prev, ...response.data?.journey } : prev));
            toast.success(`Liveness saved — score ${response.data?.liveness?.score ?? result.score}/100.`);
        } catch (err) {
            const message = err.message || 'Failed to save the liveness result.';
            setError(message);
            toast.error(message);
            throw err;
        }
    };

    const profile = journey?.profile || null;
    const documents = journey?.steps?.find((s) => s.key === 'DOCUMENTS')?.records || [];

    const profileEntries = profile ? [
        ['Full name', profile.fullName],
        ['Email', profile.email],
        ['Mobile', profile.mobile],
        ['Date of birth', profile.dob],
        ['Role', profile.role],
        ['KYC status', profile.kyc],
        ['KYC step', profile.kycStep],
        ['KYC category', profile.kycCategory],
        ['Shop name', profile.shopname],
        ['Company name', profile.companyName],
        ['Business type', profile.businessType],
        ['Business category', profile.businessCategory],
        ['CIN', profile.cin],
        ['GST number', profile.gstNumber],
        ['GST legal name', profile.gstLegalName],
        ['PAN', profile.pan],
        ['PAN status', profile.panStatus],
        ['Authority name', profile.authorityFullName],
        ['Authority email', profile.authorityEmail],
        ['Authority PAN', profile.authorityPan],
        ['Authority PAN status', profile.authorityPanStatus],
        ['Personal address', profile.address],
        ['City', profile.city],
        ['State', profile.state],
        ['Pincode', profile.pincode],
        ['Registered address', profile.registeredAddress],
        ['Business address', profile.businessAddress],
        ['Business city', profile.businessCity],
        ['Business state', profile.businessState],
        ['Business pincode', profile.businessPincode],
        ['Bank name', profile.bankName],
        ['Account holder', profile.accountHolderName],
        ['Account number', profile.accountNumberMasked],
        ['IFSC', profile.ifscCode],
        ['Branch', profile.branchName],
        ['DigiLocker', profile.digilockerRegistered ? 'Registered' : 'Not registered'],
        ['DigiLocker ID', profile.digilockerId],
        ['DigiLocker verified', profile.digilockerVerifiedAt ? formatDateTime(profile.digilockerVerifiedAt) : null],
        ['PEP status', profile.pepStatus],
        ['Blocked', profile.isBlocked ? 'Yes' : 'No'],
        ['Selfie on file', profile.hasSelfie ? 'Yes' : 'No'],
        ['Video KYC', profile.hasVideoKyc ? 'Yes' : 'No'],
        ['Expected sales', profile.expectedSales],
        ['Submitted', profile.createdAt ? formatDateTime(profile.createdAt) : null],
        ['Last updated', profile.updatedAt ? formatDateTime(profile.updatedAt) : null]
    ] : [];

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold text-slate-100">KYC Verification</h1>
                    <p className="text-xs text-slate-500">Inspect a customer, walk their KYC journey, run a camera liveness test and record the decision</p>
                </div>
                {journey && (
                    <div className="flex items-center gap-2">
                        <Badge value={journey.kycStatus} />
                        <span className="text-xs text-slate-400">{journey.completionPercent}% complete</span>
                    </div>
                )}
            </div>

            <ErrorNotice message={error} />

            <Card title="Select customer" subtitle="Pick from the directory or paste a UUID, then the verification workspace loads below">
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
                <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                    <TextInput
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={uuid}
                        onChange={(e) => setUuid(e.target.value)}
                        className="font-mono"
                    />
                    <Button type="button" disabled={loading || !uuid.trim()} className="sm:w-44" onClick={() => loadCustomer(uuid)}>
                        {loading ? 'Loading…' : 'Load customer'}
                    </Button>
                </div>
            </Card>

            {loading && !journey && <Spinner label="Loading KYC workspace…" />}

            {journey && (
                <Card
                    title={`${profile?.fullName || 'Customer'} · verification workspace`}
                    subtitle={`${profile?.email || ''} · ${profile?.mobile || ''}`}
                    actions={<span className="font-mono text-[10px] text-slate-500">{profile?.uuid}</span>}
                >
                    <div className="space-y-4">
                        {/* Tabs */}
                        <div className="flex gap-1 border-b border-slate-800 pb-1">
                            {TABS.map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => setTab(t)}
                                    className={`rounded-t-md px-3 py-1.5 text-xs font-medium transition ${tab === t ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'}`}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>

                        {tab === 'Details' && (
                            <div className="space-y-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-xs font-semibold text-slate-300">
                                        Completion {journey.completionPercent}% ({journey.completed}/{journey.total})
                                    </p>
                                    {profile?.kycRejectionReason && (
                                        <span className="text-[11px] text-rose-300">{profile.kycRejectionReason}</span>
                                    )}
                                </div>
                                <DetailGrid entries={profileEntries} />
                            </div>
                        )}

                        {tab === 'Journey' && (
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="text-xs font-semibold text-slate-300">
                                        KYC journey · {journey.completionPercent}% complete ({journey.completed}/{journey.total})
                                    </p>
                                    <Badge value={journey.kycStatus} />
                                </div>
                                <ul className="space-y-1.5">
                                    {journey.steps.map((step) => (
                                        <li key={step.key} className="flex items-start justify-between gap-3 text-[11px]">
                                            <div>
                                                <p className="text-slate-300">{step.label}</p>
                                                <p className="text-slate-500">{step.detail}</p>
                                            </div>
                                            <Badge value={step.status} />
                                        </li>
                                    ))}
                                </ul>

                                {journey.blockers?.length > 0 && (
                                    <div className="rounded border border-rose-900/60 bg-rose-950/20 p-2 text-[11px] text-rose-200">
                                        <p className="font-semibold">Blockers</p>
                                        <ul className="list-disc pl-4">
                                            {journey.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
                                        </ul>
                                    </div>
                                )}

                                {journey.missing?.length > 0 && (
                                    <div className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-[11px] text-amber-200">
                                        <p className="font-semibold">Missing</p>
                                        <ul className="list-disc pl-4">
                                            {journey.missing.map((item, index) => <li key={index}>{item}</li>)}
                                        </ul>
                                    </div>
                                )}

                                {documents.length > 0 && (
                                    <div className="space-y-1.5">
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Documents</p>
                                        {documents.map((doc) => (
                                            <div key={doc.uuid || doc.type} className="flex items-center justify-between gap-2 rounded bg-slate-900/50 px-2 py-1.5 text-[11px]">
                                                <span className="text-slate-300">
                                                    {doc.type} <Badge value={doc.status} />
                                                    {doc.rejectionReason && <span className="ml-1 text-rose-300">({doc.rejectionReason})</span>}
                                                </span>
                                                <div className="flex gap-2">
                                                    <button
                                                        type="button"
                                                        className="text-emerald-300 hover:underline disabled:opacity-50"
                                                        disabled={docSaving === doc.uuid}
                                                        onClick={() => reviewDocument(doc.uuid, 'verified')}
                                                    >
                                                        Verify
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="text-rose-300 hover:underline disabled:opacity-50"
                                                        disabled={docSaving === doc.uuid}
                                                        onClick={() => reviewDocument(doc.uuid, 'rejected')}
                                                    >
                                                        Reject
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {tab === 'Liveness' && (
                            <LivenessCheck onSave={saveLiveness} savedAt={profile?.hasSelfie} />
                        )}

                        {/* Admin decision */}
                        <form onSubmit={submitDecision} className="space-y-3 border-t border-slate-800 pt-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Admin decision</p>

                            {passwordMissing && (
                                <div className="space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
                                    <p className="text-xs font-semibold text-amber-200">KYC private password not set yet</p>
                                    <p className="text-[11px] text-amber-300/80">
                                        The backend requires a private password for every KYC change (documents and decisions). Set it once — it will be reused for this action.
                                    </p>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <TextInput
                                            type="password"
                                            value={newPrivatePassword}
                                            onChange={(e) => setNewPrivatePassword(e.target.value)}
                                            placeholder="Choose a private password"
                                        />
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            disabled={settingPassword || !newPrivatePassword.trim()}
                                            onClick={savePrivatePassword}
                                        >
                                            {settingPassword ? 'Saving…' : 'Set password'}
                                        </Button>
                                    </div>
                                </div>
                            )}
                            <div className="grid gap-3 sm:grid-cols-3">
                                <Field label="Decision">
                                    <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
                                        <option value="Approved">Approved</option>
                                        <option value="Rejected">Rejected</option>
                                        <option value="Pending">Pending</option>
                                    </Select>
                                </Field>

                                <Field label={decision === 'Rejected' ? 'Rejection reason' : ' '} hint={decision === 'Rejected' ? 'Required when rejecting' : undefined}>
                                    <TextInput
                                        required={decision === 'Rejected'}
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                        placeholder={decision === 'Rejected' ? 'Documents unreadable' : 'Optional note'}
                                    />
                                </Field>

                                <Field label="Admin private password" hint="Required to authorise KYC changes">
                                    <TextInput
                                        type="password"
                                        required
                                        value={privatePassword}
                                        onChange={(e) => setPrivatePassword(e.target.value)}
                                        placeholder="••••••••"
                                    />
                                </Field>
                            </div>
                            <div className="flex justify-end">
                                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : `Mark ${decision}`}</Button>
                            </div>
                        </form>
                    </div>
                </Card>
            )}

            {!journey && !loading && (
                <EmptyState
                    title="No customer selected"
                    description="Choose a customer from the directory above to open the verification workspace."
                />
            )}
        </div>
    );
}
