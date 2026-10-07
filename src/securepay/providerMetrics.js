/**
 * Rolling in-process provider latency metrics.
 *
 * Success RATES come from the database (they are durable), but per-call
 * LATENCY is measured here because recording a row per provider call would
 * bloat the timeline for no operational benefit.
 *
 * The window is per-process and resets on restart; every consumer surfaces the
 * sample count so a low-confidence figure is never presented as a hard fact.
 * For multi-instance deployments this should move to a shared store.
 */

const WINDOW_SIZE = 200;

/** @type {Map<string, Array<{durationMs:number, ok:boolean, at:number}>>} */
const windows = new Map();

export const recordProviderCall = (provider, { durationMs, ok = true } = {}) => {
    const code = String(provider || 'UNKNOWN').toUpperCase();
    const duration = Number(durationMs);

    if (!Number.isFinite(duration) || duration < 0) return null;

    const window = windows.get(code) || [];
    window.push({
        durationMs: Number(duration.toFixed(2)),
        ok: Boolean(ok),
        at: Date.now()
    });

    while (window.length > WINDOW_SIZE) window.shift();
    windows.set(code, window);

    return window[window.length - 1];
};

const percentile = (sortedValues, fraction) => {
    if (!sortedValues.length) return null;
    const index = Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length));
    return Number(sortedValues[index].toFixed(2));
};

export const getProviderLatency = (provider) => {
    const code = String(provider || '').toUpperCase();
    const window = windows.get(code) || [];

    if (!window.length) {
        return {
            samples: 0,
            avgLatencyMs: null,
            p95LatencyMs: null,
            maxLatencyMs: null,
            errorRate: null
        };
    }

    const durations = window.map((entry) => entry.durationMs).sort((a, b) => a - b);
    const sum = durations.reduce((total, value) => total + value, 0);
    const errors = window.filter((entry) => !entry.ok).length;

    return {
        samples: window.length,
        avgLatencyMs: Number((sum / durations.length).toFixed(2)),
        p95LatencyMs: percentile(durations, 0.95),
        maxLatencyMs: Number(durations[durations.length - 1].toFixed(2)),
        errorRate: Number(((errors / window.length) * 100).toFixed(2))
    };
};

export const getAllProviderLatency = () => {
    const result = {};
    for (const code of windows.keys()) {
        result[code] = getProviderLatency(code);
    }
    return result;
};

/** Test helper. */
export const resetProviderMetrics = () => windows.clear();

export const METRICS_WINDOW_SIZE = WINDOW_SIZE;
