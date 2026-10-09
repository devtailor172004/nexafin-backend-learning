import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Select, Spinner, TextInput } from '../components/ui.jsx';
import DetailGrid from '../components/DetailGrid.jsx';
import LivenessCheck from '../components/LivenessCheck.jsx';
import { formatDateTime } from '../lib/format.js';

const STATUS_OPTIONS = ['Pending', 'Approved', 'Rejected'];
const TABS = ['Details', 'Journey', 'Liveness'];

export default function Kyc() {
    const toast = useToast();
    const [status, setStatus] = useState('Pending');
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    const [active, setActive] = useState(null);
    const [tab, setTab] = useState('Details');
    const [privatePassword, setPrivatePassword] = useState('');
    const [reason, setReason] = useState('');
    const [decision, setDecision] = useState('Approved');
    const [saving, setSaving] = useState(false);

    const [journey, setJourney] = useState(null);
    const [journeyLoading, setJourneyLoading] = useState(false);
    const [docSaving, setDocSaving] = useState(null);

    const [passwordMissing, setPasswordMissing] = useState(false);
    const [newPrivatePassword, setNewPrivatePassword] = useState('');
    const [settingPassword, setSettingPassword] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const response = await endpoints.kycList(status);
            setProfiles(response.data?.users || []);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load KYC profiles.');
        } finally {
            setLoading(false);
        }
    }, [status]);

    useEffect(() => { load(); }, [load]);

    const openReview = useCallback(async (profile, nextDecision) => {
        setActive(profile);
        setDecision(nextDecision);
        setNotice(null);
        setReason('');
        setJourney(null);
        setTab('Details');
        setJourneyLoading(true);
        try {
            const response = await endpoints.kycJourney(profile.uuid);
            setJourney(response.data);
        } catch (err) {
            setError(err.message || 'Failed to load the KYC journey.');
        } finally {
            setJourneyLoading(false);
        }
    }, []);

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
        if (!active) return;

        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await endpoints.kycApprove(active.uuid, {
                status: decision.toLowerCase(),
                reason,
                privatePassword
            });
            setNotice(`${active.fullName} marked as ${decision}.`);
            toast.success(`${active.fullName} marked as ${decision}.`);
            setActive(null);
            setPrivatePassword('');
            setReason('');
            await load();
        } catch (err) {
            handleKycError(err, 'Failed to update KYC status.');
        } finally {
            setSaving(false);
        }
    };

    const reviewDocument = async (documentUuid, nextStatus) => {
        if (!active) return;
        setDocSaving(documentUuid);
        setError(null);
        setNotice(null);
        try {
            const response = await endpoints.kycReviewDocument(active.uuid, documentUuid, {
                status: nextStatus,
                reason: nextStatus === 'rejected' ? (reason || 'Rejected by admin') : undefined,
                private_password: privatePassword
            });
            setJourney((prev) => (prev ? { ...prev, ...response.data?.journey } : prev));
            setNotice(`Document marked as ${nextStatus}.`);
            toast.success(`Document marked as ${nextStatus}.`);
        } catch (err) {
            handleKycError(err, 'Failed to update the document.');
        } finally {
            setDocSaving(null);
        }
    };

    const saveLiveness = async (result) => {
        if (!active) return;
        setError(null);
        setNotice(null);
        try {
            const response = await endpoints.kycLiveness(active.uuid, {
                selfie: result.selfie,
                passed: result.passed,
                score: result.score,
                challenge: result.challenge,
                captureMs: result.captureMs
            });
            setJourney((prev) => (prev ? { ...prev, ...response.data?.journey } : prev));
            setNotice(`Liveness check saved (score ${response.data?.liveness?.score ?? result.score}/100).`);
            toast.success(`Liveness saved — score ${response.data?.liveness?.score ?? result.score}/100.`);
        } catch (err) {
            setError(err.message || 'Failed to save the liveness result.');
            toast.error(err.message || 'Failed to save the liveness result.');
            throw err;
        }
    };

    const documents = journey?.steps?.find((s) => s.key === 'DOCUMENTS')?.records || [];
    const profile = journey?.profile || null;

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
                    <h1 className="text-lg font-semibold text-slate-100">KYC Review</h1>
                    <p className="text-xs text-slate-400">Full applicant details, journey, documents and camera liveness testing</p>
                </div>
                <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
                    {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
            </div>

            <ErrorNotice message={error} onRetry={load} />
            {notice && (
                <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">{notice}</div>
            )}

            <Card title={`${status} profiles`} subtitle="Open Review to see every KYC detail, verify documents and run a liveness test">
                {loading && profiles.length === 0 ? (
                    <Spinner label="Loading KYC profiles…" />
                ) : profiles.length === 0 ? (
                    <EmptyState title={`No ${status.toLowerCase()} KYC profiles`} />
                ) : (
                    <div className="-mx-4 overflow-x-auto sm:mx-0">
                        <table className="w-full min-w-[720px] text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-400">
                                    <th className="px-3 py-2 font-medium">Merchant</th>
                                    <th className="px-3 py-2 font-medium">Contact</th>
                                    <th className="px-3 py-2 font-medium">DOB</th>
                                    <th className="px-3 py-2 font-medium">Business</th>
                                    <th className="px-3 py-2 font-medium">Updated</th>
                                    <th className="px-3 py-2 font-medium">KYC</th>
                                    <th className="px-3 py-2 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {profiles.map((profile) => (
                                    <tr key={profile.uuid} className="border-b border-slate-900/70 last:border-0 hover:bg-slate-900/40">
                                        <td className="px-3 py-2">
                                            <p className="text-slate-200">{profile.fullName}</p>
                                            <p className="font-mono text-[11px] text-slate-400">{profile.uuid}</p>
                                        </td>
                                        <td className="px-3 py-2 text-xs text-slate-400">
                                            <p>{profile.email}</p>
                                            <p>{profile.mobile}</p>
                                        </td>
                                        <td className="px-3 py-2 text-xs text-slate-400">{profile.dob || '—'}</td>
                                        <td className="px-3 py-2 text-xs text-slate-400">{profile.business_type || '—'}</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{formatDateTime(profile.updatedAt)}</td>
                                        <td className="px-3 py-2"><Badge value={profile.kyc} /></td>
                                        <td className="px-3 py-2 text-right">
                                            <Button
                                                variant="secondary"
                                                onClick={() => openReview(profile, profile.kyc === 'Approved' ? 'Rejected' : 'Approved')}
                                            >
                                                Review
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            {active && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setActive(null)} />
                    <form onSubmit={submitDecision} className="relative flex max-h-[92vh] w-full max-w-3xl flex-col space-y-4 overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1120] p-5">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                                <h2 className="text-sm font-semibold text-slate-100">KYC review — {active.fullName}</h2>
                                <p className="mt-1 text-xs text-slate-400">{active.email} · {active.mobile}</p>
                                <p className="mt-0.5 font-mono text-[11px] text-slate-400">{active.uuid}</p>
                            </div>
                            <div className="flex items-center gap-2">
                                {journey && <Badge value={journey.kycStatus} />}
                                <button type="button" className="text-slate-400 hover:text-slate-300" onClick={() => setActive(null)}>✕</button>
                            </div>
                        </div>

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

                        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                            {journeyLoading && <Spinner label="Loading KYC journey…" />}

                            {journey && tab === 'Details' && (
                                <>
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs font-semibold text-slate-300">
                                            Completion {journey.completionPercent}% ({journey.completed}/{journey.total})
                                        </p>
                                        {profile?.kycRejectionReason && (
                                            <span className="text-xs text-rose-300">{profile.kycRejectionReason}</span>
                                        )}
                                    </div>
                                    <DetailGrid entries={profileEntries} />
                                </>
                            )}

                            {journey && tab === 'Journey' && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs font-semibold text-slate-300">
                                            KYC journey · {journey.completionPercent}% complete ({journey.completed}/{journey.total})
                                        </p>
                                        <Badge value={journey.kycStatus} />
                                    </div>
                                    <ul className="space-y-1.5">
                                        {journey.steps.map((step) => (
                                            <li key={step.key} className="flex items-start justify-between gap-3 text-xs">
                                                <div>
                                                    <p className="text-slate-300">{step.label}</p>
                                                    <p className="text-slate-400">{step.detail}</p>
                                                </div>
                                                <Badge value={step.status} />
                                            </li>
                                        ))}
                                    </ul>

                                    {journey.blockers?.length > 0 && (
                                        <div className="rounded border border-rose-900/60 bg-rose-950/20 p-2 text-xs text-rose-200">
                                            <p className="font-semibold">Blockers</p>
                                            <ul className="list-disc pl-4">
                                                {journey.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
                                            </ul>
                                        </div>
                                    )}

                                    {journey.missing?.length > 0 && (
                                        <div className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-xs text-amber-200">
                                            <p className="font-semibold">Missing</p>
                                            <ul className="list-disc pl-4">
                                                {journey.missing.map((item, index) => <li key={index}>{item}</li>)}
                                            </ul>
                                        </div>
                                    )}

                                    {documents.length > 0 && (
                                        <div className="space-y-1.5">
                                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Documents</p>
                                            {documents.map((doc) => (
                                                <div key={doc.uuid || doc.type} className="flex items-center justify-between gap-2 rounded bg-slate-900/50 px-2 py-1.5 text-xs">
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
                                <LivenessCheck
                                    onSave={saveLiveness}
                                    savedAt={profile?.hasSelfie}
                                />
                            )}
                        </div>

                        <div className="space-y-3 border-t border-slate-800 pt-3">
                            {passwordMissing && (
                                <div className="space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
                                    <p className="text-xs font-semibold text-amber-200">KYC private password not set yet</p>
                                    <p className="text-xs text-amber-300/80">
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

                            <div className="grid gap-3 sm:grid-cols-2">
                                <Field label="Decision">
                                    <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
                                        <option value="Approved">Approved</option>
                                        <option value="Rejected">Rejected</option>
                                    </Select>
                                </Field>

                                {decision === 'Rejected' ? (
                                    <Field label="Rejection reason" hint="Required when rejecting">
                                        <TextInput required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Documents unreadable" />
                                    </Field>
                                ) : (
                                    <Field label="Admin private password" hint="Required to authorise KYC changes">
                                        <TextInput
                                            type="password"
                                            required
                                            value={privatePassword}
                                            onChange={(e) => setPrivatePassword(e.target.value)}
                                            placeholder="••••••••"
                                        />
                                    </Field>
                                )}
                            </div>

                            {decision === 'Rejected' && (
                                <Field label="Admin private password" hint="Required to authorise KYC changes">
                                    <TextInput
                                        type="password"
                                        required
                                        value={privatePassword}
                                        onChange={(e) => setPrivatePassword(e.target.value)}
                                        placeholder="••••••••"
                                    />
                                </Field>
                            )}

                            <div className="flex justify-end gap-2">
                                <Button type="button" variant="secondary" onClick={() => setActive(null)}>Cancel</Button>
                                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : `Mark ${decision}`}</Button>
                            </div>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
