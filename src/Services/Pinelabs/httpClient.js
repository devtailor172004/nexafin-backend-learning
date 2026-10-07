import fetch from 'node-fetch';
import { recordProviderCall } from '../../securepay/providerMetrics.js';

export const PROVIDER_CODE = 'PINELABS';

/**
 * Timed wrapper around the outbound Pine Labs HTTP call.
 *
 * Every provider request goes through here so latency and error rate are
 * measured in one place instead of being re-instrumented at each call site.
 * Timing is recorded in a `finally` block, so a thrown request is still
 * counted (as an error).
 */
export const plFetch = async (url, options = {}) => {
    const startedAt = process.hrtime.bigint();
    let ok = true;

    try {
        const response = await fetch(url, options);
        ok = Boolean(response.ok);
        return response;
    } catch (error) {
        ok = false;
        throw error;
    } finally {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        recordProviderCall(PROVIDER_CODE, { durationMs, ok });
    }
};

export default plFetch;
