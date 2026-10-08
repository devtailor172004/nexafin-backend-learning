import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKycJourney, KYC_STEP } from '../src/securepay/kycJourney.js';

/**
 * The KYC journey is pure (rows in, steps out) so it can be verified without a
 * database. These tests pin the two things that matter for a reviewer:
 * what is complete, and what is blocking.
 */

const completeUser = {
    company_name: 'Acme Pvt Ltd',
    business_type: 'Private Limited',
    cin: 'U12345MH2020PTC123456',
    authority_fullName: 'A Owner',
    authority_pancard: 'ABCDE1234F',
    authority_pan_verification_status: 'verified',
    pancard: 'ABCDE1234F',
    pan_verification_status: 'verified',
    digilocker_registered: 1,
    digilocker_id: '123456789012',
    business_address: '1 Test Road',
    business_pincode: 400001,
    business_state: 'MH',
    business_city: 'Mumbai',
    accountnumber: '1234567890',
    ifsccode: 'HDFC0000123',
    accountHoldername: 'Acme Pvt Ltd',
    pan_card_url: 'https://example.com/pan.pdf',
    aadhar_card_url: 'https://example.com/aadhaar.pdf',
    business_proof_url: 'https://example.com/proof.pdf',
    merchant_video: 'https://example.com/video.mp4',
    kyc: 'Approved'
};

const completeDirectors = [{
    director_name: 'A Owner',
    pancard: 'ABCDE1234F',
    pan_verification_status: 'verified',
    aadharcard_verification_status: 'verified'
}];

test('an empty profile is not verified and reports missing fields', () => {
    const journey = buildKycJourney({ user: {} });
    assert.equal(journey.verified, false);
    assert.equal(journey.completionPercent, 0);
    assert.ok(journey.steps.length >= 8, 'expected the full journey');
    assert.ok(journey.missing.length > 0, 'expected missing fields to be reported');
});

test('a fully complete profile is verified at 100%', () => {
    const journey = buildKycJourney({ user: completeUser, directors: completeDirectors, documents: [] });
    assert.equal(journey.verified, true, `blockers: ${journey.blockers.join(' | ')}`);
    assert.equal(journey.completionPercent, 100);
    assert.equal(journey.completed, journey.total);
});

test('a rejected KYC surfaces the rejection reason as a blocker', () => {
    const journey = buildKycJourney({
        user: { ...completeUser, kyc: 'Rejected', kyc_rejection_reason: 'Blurred PAN' },
        directors: completeDirectors
    });
    assert.equal(journey.kycStatus, 'Rejected');
    assert.ok(journey.blockers.some((b) => b.includes('Blurred PAN')), `blockers: ${journey.blockers.join(' | ')}`);
});

test('unverified directors block verification', () => {
    const journey = buildKycJourney({
        user: completeUser,
        directors: [{ director_name: 'B Partner', pancard: 'ZZZZZ9999Z', pan_verification_status: 'pending', aadharcard_verification_status: 'pending' }]
    });
    const directorsStep = journey.steps.find((s) => s.key === 'DIRECTORS');
    assert.equal(directorsStep.status, KYC_STEP.PENDING);
    assert.equal(journey.verified, false);
});

test('a recorded liveness test shows up as a dedicated journey step', () => {
    const journey = buildKycJourney({
        user: completeUser,
        directors: completeDirectors,
        documents: [{ uuid: 'live-1', document_type: 'LIVENESS_CHECK', status: 'verified', rejection_reason: null }]
    });
    const livenessStep = journey.steps.find((s) => s.key === 'LIVENESS');
    assert.ok(livenessStep, 'expected a LIVENESS step');
    assert.equal(livenessStep.status, KYC_STEP.COMPLETE);
    assert.equal(livenessStep.evidence.uuid, 'live-1');
    // Liveness never inflates the completion denominator
    assert.equal(journey.completionPercent, 100);
    assert.equal(journey.verified, true);
});

test('a pending liveness test is pending, a rejected one blocks', () => {
    const pending = buildKycJourney({
        user: completeUser,
        documents: [{ uuid: 'live-2', document_type: 'LIVENESS_CHECK', status: 'pending' }]
    });
    assert.equal(pending.steps.find((s) => s.key === 'LIVENESS').status, KYC_STEP.PENDING);

    const rejected = buildKycJourney({
        user: completeUser,
        documents: [{ uuid: 'live-3', document_type: 'LIVENESS_CHECK', status: 'rejected', rejection_reason: 'Photo of a photo' }]
    });
    const step = rejected.steps.find((s) => s.key === 'LIVENESS');
    assert.equal(step.status, KYC_STEP.REJECTED);
    assert.ok(rejected.blockers.some((b) => b.includes('Photo of a photo')), `blockers: ${rejected.blockers.join(' | ')}`);
});

test('a user with no liveness record has a NOT_STARTED liveness step', () => {
    const journey = buildKycJourney({ user: completeUser, documents: [] });
    const step = journey.steps.find((s) => s.key === 'LIVENESS');
    assert.ok(step, 'expected a LIVENESS step even without evidence');
    assert.equal(step.status, KYC_STEP.NOT_STARTED);
});

test('rejected documents put the DOCUMENTS step in a rejected state', () => {
    const journey = buildKycJourney({
        user: completeUser,
        directors: completeDirectors,
        documents: [{ uuid: 'doc-1', document_type: 'PAN', status: 'rejected', rejection_reason: 'Unreadable' }]
    });
    const docsStep = journey.steps.find((s) => s.key === 'DOCUMENTS');
    assert.equal(docsStep.status, KYC_STEP.REJECTED);
    assert.equal(docsStep.records[0].uuid, 'doc-1');
});
