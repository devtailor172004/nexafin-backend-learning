import crypto from 'crypto';
import { ApiError } from '../../utils/ApiError.js';
import { HTTP_STATUS } from '../../utils/httpStatus.js';
import logger from '../../utils/logger.js';

/**
 * Pine Labs webhook signature verification.
 *
 * Signed content:  `${webhookId}.${webhookTimestamp}.${rawBody}`
 * Algorithm:       HMAC-SHA256, base64 encoded (optionally prefixed "v1,")
 *
 * IMPORTANT: this module FAILS CLOSED. There is no "non-production bypass".
 * Local/sandbox testing uses the dedicated mock webhook endpoint instead, so
 * a misconfigured environment can never silently accept unsigned webhooks.
 */

export const WEBHOOK_MAX_AGE_SECONDS = 10 * 60; // 10 minutes

/**
 * Normalizes a provider timestamp to Unix seconds.
 * Accepts Unix seconds, Unix milliseconds and ISO-ish strings.
 *
 * @returns {number|null} Unix seconds, or null when unparseable
 */
export const normalizeWebhookTimestamp = (webhookTimestamp) => {
    if (webhookTimestamp === undefined || webhookTimestamp === null || webhookTimestamp === '') {
        return null;
    }

    const numeric = Number(webhookTimestamp);
    if (Number.isFinite(numeric)) {
        return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }

    const normalized = String(webhookTimestamp)
        .trim()
        .replace(' ', 'T')
        .replace(/:(\d{1,4})$/, '.$1');

    const parsed = Date.parse(normalized);
    if (Number.isNaN(parsed)) return null;

    return Math.floor(parsed / 1000);
};

/**
 * @returns {{fresh:boolean, webhookTime:number|null, ageSeconds:number|null}}
 */
export const checkWebhookTimestamp = (webhookTimestamp, maxAgeSeconds = WEBHOOK_MAX_AGE_SECONDS) => {
    const webhookTime = normalizeWebhookTimestamp(webhookTimestamp);
    if (webhookTime === null) {
        return { fresh: false, webhookTime: null, ageSeconds: null };
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const ageSeconds = Math.abs(currentTime - webhookTime);

    return {
        fresh: ageSeconds <= maxAgeSeconds,
        webhookTime,
        ageSeconds
    };
};

/**
 * Returns the secret key candidates (raw utf8, base64-decoded, hex-decoded)
 * because deployments have historically supplied the secret in different
 * encodings.
 */
const buildSecretCandidates = (secretKey) => {
    const trimmed = String(secretKey).trim();
    const candidates = [Buffer.from(trimmed, 'utf8')];

    try {
        const base64Decoded = Buffer.from(trimmed, 'base64');
        if (base64Decoded.length) candidates.push(base64Decoded);
    } catch {
        // ignore
    }

    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
            candidates.push(Buffer.from(trimmed, 'hex'));
        } catch {
            // ignore
        }
    }

    return candidates;
};

const normalizeSignature = (signature) => String(signature || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/^v\d+,/, '');

/**
 * Verifies a Pine Labs webhook signature.
 *
 * @param {object} params
 * @param {string} params.webhookId
 * @param {string} params.webhookTimestamp
 * @param {string} params.webhookSignature
 * @param {Buffer|string} params.rawBody
 * @param {string} [params.secretKey] Defaults to PINE_LABS_CLIENT_SECRET
 * @returns {boolean} true only on a valid signature
 * @throws {ApiError} 500 when the secret is not configured (fail closed)
 */
export const verifyPineLabsWebhookSignature = ({
    webhookId,
    webhookTimestamp,
    webhookSignature,
    rawBody,
    secretKey = process.env.PINE_LABS_CLIENT_SECRET
}) => {
    if (!secretKey || String(secretKey).trim() === '' || secretKey === 'YOUR_CLIENT_SECRET') {
        throw new ApiError(
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            'PINE_LABS_CLIENT_SECRET is not configured. Refusing to process a provider webhook without signature verification.'
        );
    }

    if (!webhookId || !webhookTimestamp || !webhookSignature || !rawBody) {
        logger.warn('[Webhook] Missing signature verification components (webhook-id / timestamp / signature / body).');
        return false;
    }

    const body = (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)).trimEnd();
    if (!body) return false;

    const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
    const receivedSig = normalizeSignature(webhookSignature);
    if (!receivedSig) return false;

    const receivedBuffer = Buffer.from(receivedSig, 'utf8');
    const secretCandidates = buildSecretCandidates(secretKey);

    for (const secretBytes of secretCandidates) {
        const generatedSignature = crypto
            .createHmac('sha256', secretBytes)
            .update(signedContent, 'utf8')
            .digest('base64');

        const generatedBuffer = Buffer.from(generatedSignature, 'utf8');

        if (generatedBuffer.length === receivedBuffer.length &&
            crypto.timingSafeEqual(generatedBuffer, receivedBuffer)) {
            return true;
        }
    }

    return false;
};

export default verifyPineLabsWebhookSignature;
