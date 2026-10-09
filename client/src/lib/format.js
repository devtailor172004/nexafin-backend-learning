export const formatCurrency = (value, currency = 'INR') => {
    const amount = Number(value || 0);
    try {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency,
            maximumFractionDigits: 2
        }).format(amount);
    } catch {
        return `${currency} ${amount.toFixed(2)}`;
    }
};

export const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

export const formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
};

export const formatTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('en-IN', { hour12: false });
};

export const formatSeconds = (value) => {
    if (value === null || value === undefined) return '—';
    return `${Number(value).toFixed(2)}s`;
};

export const percent = (value) => `${Number(value || 0).toFixed(1)}%`;

const STATUS_STYLES = {
    PROCESSED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    AUTHORIZED: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    PENDING: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    CREATED: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
    FAILED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    CANCELLED: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
    EXPIRED: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
    REFUND_PENDING: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
    REFUNDED: 'bg-teal-500/15 text-teal-300 ring-teal-500/30',
    REFUND_FAILED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',

    HEALTHY: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    DEGRADED: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    UNHEALTHY: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    NO_TRAFFIC: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
    NOT_INTEGRATED: 'bg-slate-600/15 text-slate-400 ring-slate-600/30',

    Approved: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    Rejected: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',

    // ---- Security Center (risk decisions, levels, workflow states) ----
    ALLOW: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    STEP_UP: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    HOLD: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    BLOCK: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',

    LOW: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    MEDIUM: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    HIGH: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
    CRITICAL: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',

    OPEN: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    UNDER_REVIEW: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    RESOLVED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    DISMISSED: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
    INVESTIGATING: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    CLOSED: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',

    ACTIVE: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    RELEASED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',

    PASSED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    FAILED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    VALID: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    INVALID: 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
};

export const statusStyle = (status) => (
    STATUS_STYLES[status] || 'bg-slate-500/15 text-slate-300 ring-slate-500/30'
);
