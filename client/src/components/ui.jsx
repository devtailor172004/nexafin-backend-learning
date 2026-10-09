import { statusStyle } from '../lib/format.js';

export function Card({ title, subtitle, actions, children, className = '' }) {
    return (
        <section className={`rounded-2xl border border-slate-800 bg-[#0e1526] shadow-lg shadow-black/20 ${className}`}>
            {(title || actions) && (
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-5">
                    <div>
                        {title && <h2 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h2>}
                        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
                    </div>
                    {actions}
                </header>
            )}
            <div className="p-4 sm:p-5">{children}</div>
        </section>
    );
}

export function Badge({ value, className = '' }) {
    return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${statusStyle(value)} ${className}`}>
            {value ?? '—'}
        </span>
    );
}

export function StatCard({ label, value, hint, tone = 'default' }) {
    const tones = {
        default: 'text-slate-100',
        good: 'text-emerald-300',
        warn: 'text-amber-300',
        bad: 'text-rose-300',
        info: 'text-sky-300'
    };

    return (
        <div className="rounded-2xl border border-slate-800 bg-[#0e1526] p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone] || tones.default}`}>{value}</p>
            {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
        </div>
    );
}

export function Button({ children, variant = 'primary', className = '', ...props }) {
    const variants = {
        primary: 'bg-sky-600 hover:bg-sky-500 text-white disabled:bg-sky-900',
        secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-100 disabled:opacity-50',
        danger: 'bg-rose-600 hover:bg-rose-500 text-white disabled:bg-rose-900',
        ghost: 'bg-transparent hover:bg-slate-800 text-slate-300'
    };

    return (
        <button
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${variants[variant]} ${className}`}
            {...props}
        >
            {children}
        </button>
    );
}

export function Spinner({ label = 'Loading…' }) {
    return (
        <div className="flex items-center gap-3 py-8 text-sm text-slate-400">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
            {label}
        </div>
    );
}

export function EmptyState({ title, description }) {
    return (
        <div className="py-10 text-center">
            <p className="text-sm font-medium text-slate-300">{title}</p>
            {description && <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">{description}</p>}
        </div>
    );
}

export function ErrorNotice({ message, onRetry }) {
    if (!message) return null;
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            <span>{message}</span>
            {onRetry && (
                <button onClick={onRetry} className="rounded-md bg-rose-900/60 px-2.5 py-1 text-xs font-medium hover:bg-rose-900">
                    Retry
                </button>
            )}
        </div>
    );
}

export function Field({ label, hint, children }) {
    return (
        <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
            {children}
            {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
        </label>
    );
}

export function TextInput({ className = '', ...props }) {
    return (
        <input
            className={`w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/40 ${className}`}
            {...props}
        />
    );
}

export function Select({ className = '', children, ...props }) {
    return (
        <select
            className={`w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/40 ${className}`}
            {...props}
        >
            {children}
        </select>
    );
}
