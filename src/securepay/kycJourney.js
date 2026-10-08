import Director from '../models/Director.js';
import UserDocument from '../models/UserDocument.js';

/**
 * KYC journey builder.
 *
 * Turns the flat columns scattered across `users`, `directors` and
 * `user_documents` into an ordered, reviewable journey: what is done, what is
 * still missing, and what is blocking approval.
 *
 * Pure and synchronous — callers pass the rows in, so it is trivially testable
 * and reusable by both the admin console and the ops "Customer 360" view.
 */

const STEP = Object.freeze({
    COMPLETE: 'COMPLETE',
    PENDING: 'PENDING',
    BLOCKED: 'BLOCKED',
    NOT_STARTED: 'NOT_STARTED',
    REJECTED: 'REJECTED'
});

const has = (value) => value !== null && value !== undefined && String(value).trim() !== '';

const isVerified = (value) => ['verified', 'VERIFIED', 'Verified', 'Approved', 'success'].includes(String(value));

const step = (key, label, status, detail, extra = {}) => ({ key, label, status, detail, ...extra });

/**
 * @param {object} params
 * @param {object} params.user             User instance (or plain object)
 * @param {object[]} [params.directors]
 * @param {object[]} [params.documents]
 * @returns {{steps:object[], completed:number, total:number, completionPercent:number, blockers:string[], verified:boolean, missing:string[]}}
 */
export const buildKycJourney = ({ user, directors = [], documents = [] } = {}) => {
    const u = user || {};
    const steps = [];

    // 1. Business identity
    const businessCore = has(u.company_name) && has(u.business_type);
    const businessMissing = [];
    if (!has(u.company_name)) businessMissing.push('company_name');
    if (!has(u.business_type)) businessMissing.push('business_type');
    if (u.business_type === 'Private Limited' && !has(u.cin)) businessMissing.push('cin');
    steps.push(step(
        'BUSINESS_INFO',
        'Business information',
        businessCore && businessMissing.length === 0 ? STEP.COMPLETE : (businessCore ? STEP.PENDING : STEP.NOT_STARTED),
        businessMissing.length ? `Missing: ${businessMissing.join(', ')}` : 'Company name, type and registration captured',
        { missing: businessMissing }
    ));

    // 2. Signing authority + PAN verification
    const authorityMissing = [];
    if (!has(u.authority_fullName)) authorityMissing.push('authority_fullName');
    if (!has(u.authority_pancard)) authorityMissing.push('authority_pancard');
    const authorityPanVerified = isVerified(u.authority_pan_verification_status);
    steps.push(step(
        'SIGNING_AUTHORITY',
        'Signing authority',
        authorityMissing.length === 0 && authorityPanVerified
            ? STEP.COMPLETE
            : (authorityMissing.length === 0 ? STEP.PENDING : STEP.NOT_STARTED),
        authorityMissing.length
            ? `Missing: ${authorityMissing.join(', ')}`
            : (authorityPanVerified ? 'Authority PAN verified' : 'Authority PAN not verified'),
        { missing: authorityMissing }
    ));

    // 3. PAN (merchant)
    const panVerified = isVerified(u.pan_verification_status);
    steps.push(step(
        'PAN',
        'PAN verification',
        panVerified ? STEP.COMPLETE : (has(u.pancard) ? STEP.PENDING : STEP.NOT_STARTED),
        panVerified ? 'PAN verified' : (has(u.pancard) ? 'PAN captured, not verified' : 'PAN not captured'),
        { value: u.pancard || null, verificationStatus: u.pan_verification_status || 'pending' }
    ));

    // 4. Aadhaar via DigiLocker
    const digilockerDone = Boolean(u.digilocker_registered) && has(u.digilocker_id);
    steps.push(step(
        'AADHAAR_DIGILOCKER',
        'Aadhaar (DigiLocker)',
        digilockerDone ? STEP.COMPLETE : STEP.NOT_STARTED,
        digilockerDone ? 'Aadhaar retrieved via DigiLocker' : 'DigiLocker verification pending'
    ));

    // 5. Business address
    const addressMissing = ['business_address', 'business_pincode', 'business_state', 'business_city']
        .filter((field) => !has(u[field]));
    steps.push(step(
        'BUSINESS_ADDRESS',
        'Business address',
        addressMissing.length === 0 ? STEP.COMPLETE : (has(u.business_address) ? STEP.PENDING : STEP.NOT_STARTED),
        addressMissing.length ? `Missing: ${addressMissing.join(', ')}` : 'Primary business address captured',
        { missing: addressMissing }
    ));

    // 6. Directors / partners
    const directorIssues = directors
        .map((d) => {
            const missing = [];
            if (!has(d.director_name)) missing.push('director_name');
            if (!has(d.pancard)) missing.push('pancard');
            const panOk = isVerified(d.pan_verification_status);
            const aadhaarOk = isVerified(d.aadharcard_verification_status);
            if (!panOk) missing.push('PAN not verified');
            if (!aadhaarOk) missing.push('Aadhaar not verified');
            return { name: d.director_name || 'Unnamed', missing };
        })
        .filter((entry) => entry.missing.length > 0);

    steps.push(step(
        'DIRECTORS',
        'Directors / partners',
        directors.length === 0 ? STEP.NOT_STARTED : (directorIssues.length === 0 ? STEP.COMPLETE : STEP.PENDING),
        directors.length === 0
            ? 'No directors or partners recorded'
            : (directorIssues.length === 0
                ? `${directors.length} director(s) fully verified`
                : `${directorIssues.length} of ${directors.length} director(s) incomplete`),
        { total: directors.length, incomplete: directorIssues }
    ));

    // 7. Documents
    const rejectedDocs = documents.filter((d) => d.status === 'rejected');
    const pendingDocs = documents.filter((d) => d.status === 'pending');
    const uploadedProofs = ['pan_card_url', 'aadhar_card_url', 'business_proof_url'].filter((f) => has(u[f]));
    const docCount = documents.length + uploadedProofs.length;

    let docStatus = STEP.NOT_STARTED;
    if (rejectedDocs.length) docStatus = STEP.REJECTED;
    else if (pendingDocs.length) docStatus = STEP.PENDING;
    else if (docCount > 0) docStatus = STEP.COMPLETE;

    steps.push(step(
        'DOCUMENTS',
        'Documents',
        docStatus,
        docCount === 0
            ? 'No documents uploaded'
            : `${docCount} document(s) on file${pendingDocs.length ? `, ${pendingDocs.length} pending review` : ''}${rejectedDocs.length ? `, ${rejectedDocs.length} rejected` : ''}`,
        {
            uploaded: uploadedProofs,
            records: documents.map((d) => ({
                uuid: d.uuid,
                type: d.document_type,
                status: d.status,
                url: d.document_url,
                rejectionReason: d.rejection_reason || null
            }))
        }
    ));

    // 8. Bank account
    const bankMissing = ['accountnumber', 'ifsccode', 'accountHoldername'].filter((f) => !has(u[f]));
    steps.push(step(
        'BANK',
        'Bank account',
        bankMissing.length === 0 ? STEP.COMPLETE : (has(u.accountnumber) ? STEP.PENDING : STEP.NOT_STARTED),
        bankMissing.length
            ? `Missing: ${bankMissing.join(', ')}`
            : `Account ${String(u.accountnumber).replace(/.(?=.{4})/g, '*')} at ${u.bankname || 'bank'}`,
        { missing: bankMissing }
    ));

    // 9. Liveness check (camera test evidence)
    const livenessDoc = documents.find((d) => String(d.document_type || '').toUpperCase() === 'LIVENESS_CHECK');
    let livenessStatus = STEP.NOT_STARTED;
    let livenessDetail = 'No liveness test recorded yet';
    if (livenessDoc) {
        if (livenessDoc.status === 'verified') {
            livenessStatus = STEP.COMPLETE;
            livenessDetail = 'Liveness test passed — camera evidence on file';
        } else if (livenessDoc.status === 'rejected') {
            livenessStatus = STEP.REJECTED;
            livenessDetail = livenessDoc.rejection_reason
                ? `Liveness rejected: ${livenessDoc.rejection_reason}`
                : 'Liveness test rejected by admin';
        } else {
            livenessStatus = STEP.PENDING;
            livenessDetail = 'Liveness test recorded — awaiting manual review';
        }
    }
    steps.push(step(
        'LIVENESS',
        'Liveness check (camera)',
        livenessStatus,
        livenessDetail,
        { evidence: livenessDoc ? { uuid: livenessDoc.uuid, status: livenessDoc.status } : null }
    ));

    // 10. Video KYC
    steps.push(step(
        'VIDEO_KYC',
        'Video KYC',
        has(u.merchant_video) ? STEP.COMPLETE : STEP.NOT_STARTED,
        has(u.merchant_video) ? 'Video KYC uploaded' : 'Video KYC not uploaded'
    ));

    // 11. Admin review
    const adminStatus = u.kyc === 'Approved' ? STEP.COMPLETE : (u.kyc === 'Rejected' ? STEP.REJECTED : STEP.PENDING);
    steps.push(step(
        'ADMIN_REVIEW',
        'Admin review',
        adminStatus,
        u.kyc === 'Rejected'
            ? (u.kyc_rejection_reason || 'Rejected by admin')
            : (u.kyc === 'Approved' ? 'Approved by admin' : 'Awaiting admin decision'),
        { decision: u.kyc || 'Pending' }
    ));

    // Liveness is informational until an evidence record exists — when it does,
    // a rejected record blocks via BLOCKER scan and a pending one gates through
    // the DOCUMENTS step, so it never inflates the completion denominator.
    const required = steps.filter((s) => !['LIVENESS', 'VIDEO_KYC', 'ADMIN_REVIEW'].includes(s.key));
    const completed = required.filter((s) => s.status === STEP.COMPLETE).length;
    const total = required.length;

    const blockers = [];
    steps.forEach((s) => {
        if (s.status === STEP.BLOCKED || s.status === STEP.REJECTED) blockers.push(`${s.label}: ${s.detail}`);
    });
    if (u.kyc === 'Rejected') blockers.push(`Rejected: ${u.kyc_rejection_reason || 'no reason recorded'}`);

    const missing = steps.flatMap((s) => (s.missing || []).map((m) => `${s.key}: ${m}`));

    return {
        steps,
        completed,
        total,
        completionPercent: total ? Number(((completed / total) * 100).toFixed(1)) : 0,
        verified: required.every((s) => s.status === STEP.COMPLETE),
        blockers,
        missing,
        kycStatus: u.kyc || 'Pending',
        kycStep: u.kyc_step ?? null,
        kycCategory: u.kyc_category ?? null,
        rejectionReason: u.kyc_rejection_reason || null
    };
};

/**
 * Loads the related rows and builds the journey for a user instance.
 */
export const getKycJourneyForUser = async (user) => {
    if (!user) return buildKycJourney({});

    const directorWhere = (user.business_type === 'Private Limited' && user.cin)
        ? { cin: user.cin }
        : { userId: user.id };

    const [directors, documents] = await Promise.all([
        Director.findAll({ where: directorWhere, order: [['createdAt', 'ASC']] }),
        UserDocument.findAll({ where: { userId: user.id } })
    ]);

    return buildKycJourney({ user, directors, documents });
};

export { STEP as KYC_STEP };
export default buildKycJourney;
