// Document configuration per business type
// Common docs apply to ALL business types
// Specific docs are ADDITIONAL to common docs

export const COMMON_DOCUMENTS = [
    'COI',
    'MOA',
    'AOA',
    'MCA (Latest 15 Days)*',
    'PAN of the entity',
    'GST Certificate of the entity',
    'Aadhar and Pan of Directors (Latest 15 Days)*',
    'Board Resolution for Auth. Signatory',
    'Aadhar Consent Form',
    'Merchant Criminal Undertaking',
    'Business Declaration form',
    'PEP Declaration Form',
    'CA certified Shareholding pattern',
    'Director\'s Details & UBO',
    'Cancelled cheque',
    'Photograph with Geo-Coordinates outside and inside office premises',
    'Merchant Registration Form (MRF)'
];

export const BUSINESS_TYPE_DOCUMENTS = {
    'Private Limited': [
        'Certificate of Incorporation',
        'Memorandum of Association (MoA)',
        'Articles of Association (AoA)',
        'PAN Card',
        'GST Certificate',
        'OVD of Ultimate Beneficial Owner (UBO)',
        'Board Resolution - Current Directors',
        'Board Resolution - Payment Aggregator Appointment',
        'Authorised Signatory Details & PoI',
        'Website / Online Presence Verification',
    ],
    'Partnership': [
        'Registration Certificate',
        'GST Certificate',
        'PAN Card',
        'Partnership Deed / LLP Agreement',
        'Authority Letter (Signed by Two Partners)',
        'OVD of Authorised Representative / UBO',
    ],
    'Proprietorship': [
        'PAN Card',
        'OVD of Proprietor / Authorised Representative',
        // Any 2 from below (minimum 2 required — admin validates)
        'UDYAM Registration Certificate',
        'Shop & Establishment Act License',
        'Sales and Income Tax Returns',
        'CST / VAT / GST Certificate',
        'Certificate from Tax Authorities',
        'IEC (Importer Exporter Code)',
        'Complete Income Tax Return',
        'Utility Bills (Electricity / Water / Landline)',
    ],
    'HUF': [
        'PAN Card',
        'Managing Body Resolution',
        'Power of Attorney / Authorisation',
        'HUF Deed',
        'Legal Existence Document of HUF',
    ],
    'Trust': [
        'Certificate of Registration',
        'Trust Deed',
        'PAN Card',
        'OVD of Authorised Representative / Trustee(s)',
        'List of Beneficiaries, Settlors, Trustees, Protectors',
        'Registered Office Address Proof',
        'Trustee Role Documents & Authority to Transact',
    ],
    'UnicorpAss': [
        'Managing Body Resolution',
        'PAN Card',
        'Power of Attorney / Authorisation',
        'OVD of Authorised Representative / UBO',
    ],
};

// Propriertorship: minimum 2 business-proof documents needed (admin verifies)
export const PROPRIETORSHIP_MIN_BUSINESS_PROOF = 2;
export const PROPRIETORSHIP_MANDATORY = ['PAN Card', 'OVD of Proprietor / Authorised Representative'];
export const PROPRIETORSHIP_BUSINESS_PROOFS = [
    'UDYAM Registration Certificate',
    'Shop & Establishment Act License',
    'Sales and Income Tax Returns',
    'CST / VAT / GST Certificate',
    'Certificate from Tax Authorities',
    'IEC (Importer Exporter Code)',
    'Complete Income Tax Return',
    'Utility Bills (Electricity / Water / Landline)',
];

// All valid document types (used for validation on upload)
export const ALL_VALID_DOCUMENT_TYPES = [
    ...new Set([
        ...COMMON_DOCUMENTS,
        ...Object.values(BUSINESS_TYPE_DOCUMENTS).flat(),
    ])
];

// Allowed file MIME types
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
export const MAX_FILE_SIZE_MB = 5;
