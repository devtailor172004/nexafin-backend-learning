const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export const TOKEN_KEY = 'securepay.token';
export const USER_KEY = 'securepay.user';

export const getToken = () => {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
};

export const setSession = (token, user) => {
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
        // storage unavailable (private mode) — session stays in memory only
    }
};

export const getStoredUser = () => {
    try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

export const clearSession = () => {
    try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    } catch {
        // ignore
    }
};

export class ApiError extends Error {
    constructor(message, status, payload) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.payload = payload;
    }
}

/** Generates a fresh idempotency key for a money-moving request. */
export const newIdempotencyKey = (prefix = 'ui') => {
    const uuid = (globalThis.crypto && globalThis.crypto.randomUUID)
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${uuid}`;
};

/**
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body]
 * @param {string} [options.idempotencyKey] Sent as the Idempotency-Key header
 */
export async function apiFetch(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    const token = getToken();

    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal
    });

    const text = await response.text();
    let payload = null;
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { success: false, message: text };
        }
    }

    if (!response.ok) {
        if (response.status === 401) clearSession();
        throw new ApiError(
            payload?.message || `Request failed with status ${response.status}`,
            response.status,
            payload
        );
    }

    return payload;
}

export const api = {
    get: (path, options) => apiFetch(path, { ...options, method: 'GET' }),
    post: (path, body, options) => apiFetch(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => apiFetch(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => apiFetch(path, { ...options, method: 'PATCH', body })
};

export const endpoints = {
    login: (email, password) => api.post('/api/auth/login', { email, password }),
    profile: () => api.get('/api/auth/profile'),

    dashboard: () => api.get('/api/securepay/dashboard'),
    liveTransactions: (query = '') => api.get(`/api/securepay/transactions/live${query}`),
    providerHealth: () => api.get('/api/securepay/providers/health'),
    paymentTimeline: (uuid) => api.get(`/api/securepay/payments/${uuid}/timeline`),
    explainPayment: (uuid) => api.get(`/api/securepay/payments/${uuid}/explain`),
    customerOverview: (uuid) => api.get(`/api/securepay/customers/${uuid}/overview`),

    routingPreview: (query) => api.get(`/api/securepay/routing/preview${query}`),

    reconciliationSummary: () => api.get('/api/securepay/reconciliation/summary'),
    reconciliationRuns: (query = '') => api.get(`/api/securepay/reconciliation/runs${query}`),
    reconciliationRun: (uuid) => api.get(`/api/securepay/reconciliation/runs/${uuid}`),
    createReconciliationRun: (body) => api.post('/api/securepay/reconciliation/runs', body),
    reconciliationExceptions: (query = '') => api.get(`/api/securepay/reconciliation/exceptions${query}`),
    updateReconciliationException: (uuid, body) => api.patch(`/api/securepay/reconciliation/exceptions/${uuid}`, body),

    settlementSummary: () => api.get('/api/securepay/settlements/summary'),
    runSettlement: (body = {}) => api.post('/api/securepay/settlements/run', body),

    kycJourney: (uuid) => api.get(`/api/admin/kyc/${uuid}/journey`),
    kycReviewDocument: (uuid, documentUuid, body) => api.patch(`/api/admin/kyc/${uuid}/documents/${documentUuid}/status`, body),

    // --- Payment simulator (drives the real merchant APIs) ---
    providerToken: (clientId, clientSecret) => api.post('/api/payment/nxpay/token', { clientId, clientSecret }),
    createOrder: (body, idempotencyKey) => api.post('/api/payment/nxpay/order', body, { idempotencyKey: idempotencyKey || newIdempotencyKey('sim-order') }),
    createUpiPayment: (orderUuid, body = {}) => api.post(`/api/payment/nxpay/order/${orderUuid}/upi/payments`, body, { idempotencyKey: newIdempotencyKey('sim-upi') }),
    createNetbankingPayment: (orderUuid, body) => api.post(`/api/payment/nxpay/order/${orderUuid}/netbanking/payments`, body, { idempotencyKey: newIdempotencyKey('sim-nb') }),
    createCardPayment: (orderUuid, body) => api.post(`/api/payment/nxpay/order/${orderUuid}/payments`, body),

    kycList: (status = 'Pending') => api.get(`/api/admin/kyc?status=${encodeURIComponent(status)}&limit=25`),
    kycApprove: (uuid, { status, reason, privatePassword }) => api.put(`/api/admin/kyc/${uuid}/status`, {
        status,
        reason,
        private_password: privatePassword
    })
};
