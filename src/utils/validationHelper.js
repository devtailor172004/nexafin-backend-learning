import { ApiError } from './ApiError.js';
import { HTTP_STATUS } from './httpStatus.js';

// Helper to validate Aadhaar card format (exactly 12 digits)
export const validateAadharFormat = (aadhar, name = '') => {
    const aadharRegex = /^[0-9]{12}$/;
    if (!aadharRegex.test(String(aadhar).trim())) {
        const subject = name ? ` for director '${name}'` : '';
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid Aadhaar card number format${subject}. Must be exactly 12 digits.`);
    }
    return String(aadhar).trim();
};

// Helper to validate PAN card format (ABCDE1234F)
export const validatePanFormat = (pancard) => {
    const cleanPan = String(pancard).trim().toUpperCase();
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(cleanPan)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid PAN card format. Must be like ABCDE1234F.");
    }
    return cleanPan;
};

// Helper to validate Date format (strictly YYYY-MM-DD)
export const validateDateFormat = (dateStr, fieldName = 'Date') => {
    if (!dateStr || typeof dateStr !== 'string') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `${fieldName} is required and must be a string.`);
    }
    const cleanDate = dateStr.trim();
    // Matches strictly YYYY-MM-DD format
    const dateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    if (!dateRegex.test(cleanDate)) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            `Invalid ${fieldName} format. Must be strictly in YYYY-MM-DD format (e.g., 1995-08-15).`
        );
    }
    return cleanDate;
};

// Helper to compare two names by normalizing and sorting words
export const compareNames = (name1, name2) => {
    const normalize = (n) => (n || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const norm1 = normalize(name1);
    const norm2 = normalize(name2);

    if (!norm1 || !norm2) return false;

    const words1 = norm1.split(' ').filter(Boolean);
    const words2 = norm2.split(' ').filter(Boolean);

    const sorted1 = [...words1].sort().join(' ');
    const sorted2 = [...words2].sort().join(' ');

    return norm1 === norm2 || sorted1 === sorted2;
};
