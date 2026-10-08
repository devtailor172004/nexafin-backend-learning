import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Select, Spinner, TextInput } from '../components/ui.jsx';
import { formatDateTime } from '../lib/format.js';

const STATUS_OPTIONS = ['Pending', 'Approved', 'Rejected'];

export default function Kyc() {
    const [status, setStatus] = useState('Pending');
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    const [active, setActive] = useState(null);
    const [privatePassword, setPrivatePassword] = useState('');
    const [reason, setReason] = useState('');
    const [decision, setDecision] = useState('Approved');
    const [saving, setSaving] = useState(false);

    const [journey, setJourney] = useState(null);
    const [journeyLoading, setJourneyLoading] = useState(false);
    const [docSaving, setDocSaving] = useState(null);

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
            setActive(null);
            setPrivatePassword('');
            setReason('');
            await load();
        } catch (err) {
            setError(err.message || 'Failed to update KYC status.');
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
        } catch (err) {
            setError(err.message || 'Failed to update the document.');
        } finally {
            setDocSaving(null);
        }
    };

    const documents = journey?.steps?.find((s) => s.key === 'DOCUMENTS')?.records || [];

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold text-slate-100">KYC Review</h1>
                    <p className="text-xs text-slate-500">Approve or reject merchant KYC submissions</p>
                </div>
                <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
                    {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
            </div>

            <ErrorNotice message={error} onRetry={load} />
            {notice && (
                <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">{notice}</div>
            )}

            <Card title={`${status} profiles`} subtitle="Approving a profile unlocks payments for that merchant">
                {loading && profiles.length === 0 ? (
                    <Spinner label="Loading KYC profiles…" />
                ) : profiles.length === 0 ? (
                    <EmptyState title={`No ${status.toLowerCase()} KYC profiles`} />
                ) : (
                    <div className="-mx-4 overflow-x-auto sm:mx-0">
                        <table className="w-full min-w-[640px] text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                                    <th className="px-3 py-2 font-medium">Merchant</th>
                                    <th className="px-3 py-2 font-medium">Contact</th>
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
                                            <p className="font-mono text-[10px] text-slate-500">{String(profile.uuid).slice(0, 8)}…</p>
                                        </td>
                                        <td className="px-3 py-2 text-xs text-slate-400">
                                            <p>{profile.email}</p>
                                            <p>{profile.mobile}</p>
                                        </td>
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
                    <form onSubmit={submitDecision} className="relative max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-slate-800 bg-[#0b1120] p-5">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-100">Review KYC decision</h2>
                            <p className="mt-1 text-xs text-slate-500">{active.fullName} · {active.email}</p>
                        </div>

                        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                            {journeyLoading && <Spinner label="Loading KYC journey…" />}
                            {journey && (
                                <>
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

                                    {documents.length > 0 && (
                                        <div className="space-y-1">
                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Documents</p>
                                            {documents.map((doc) => (
                                                <div key={doc.uuid || doc.type} className="flex items-center justify-between gap-2 text-[11px]">
                                                    <span className="text-slate-300">
                                                        {doc.type} <Badge value={doc.status} />
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
                                </>
                            )}
                        </div>

                        <Field label="Decision">
                            <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
                                <option value="Approved">Approved</option>
                                <option value="Rejected">Rejected</option>
                            </Select>
                        </Field>

                        {decision === 'Rejected' && (
                            <Field label="Rejection reason" hint="Required when rejecting">
                                <TextInput required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Documents unreadable" />
                            </Field>
                        )}

                        <Field label="Admin private password" hint="Required by the backend to authorise KYC changes">
                            <TextInput
                                type="password"
                                required
                                value={privatePassword}
                                onChange={(e) => setPrivatePassword(e.target.value)}
                                placeholder="••••••••"
                            />
                        </Field>

                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="secondary" onClick={() => setActive(null)}>Cancel</Button>
                            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : `Mark ${decision}`}</Button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
