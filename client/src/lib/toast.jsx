import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * Lightweight in-app notifications.
 *
 * Mount <ToastProvider> once at the app root and render <Toaster /> where
 * toasts should appear; call `const toast = useToast()` anywhere below and
 * use toast.success('Saved') / toast.error('Failed') / toast.info('…').
 */
const ToastContext = createContext(null);

const TOAST_LIFETIME_MS = 3800;

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const idRef = useRef(0);

    const dismiss = useCallback((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const push = useCallback((message, variant = 'info') => {
        if (!message) return;
        idRef.current += 1;
        const id = idRef.current;
        setToasts((prev) => [...prev.slice(-3), { id, message: String(message), variant }]);
        setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);
    }, [dismiss]);

    const value = useMemo(() => ({
        toasts,
        success: (message) => push(message, 'success'),
        error: (message) => push(message, 'error'),
        info: (message) => push(message, 'info'),
        dismiss
    }), [toasts, push, dismiss]);

    return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        // Safe fallback so a missing provider never crashes a page.
        const noop = () => {};
        return { success: noop, error: noop, info: noop, dismiss: noop };
    }
    return context;
}

const VARIANT_STYLES = {
    success: 'border-emerald-700/70 bg-emerald-950/95 text-emerald-100',
    error: 'border-rose-700/70 bg-rose-950/95 text-rose-100',
    info: 'border-sky-700/70 bg-sky-950/95 text-sky-100'
};

const VARIANT_ICON = { success: '✓', error: '✕', info: 'ℹ' };

export function Toaster() {
    const context = useContext(ToastContext);
    const toasts = context?.toasts || [];
    const dismiss = context?.dismiss || (() => {});

    if (!toasts.length) return null;

    return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    role="status"
                    className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs shadow-lg shadow-black/40 backdrop-blur ${VARIANT_STYLES[toast.variant] || VARIANT_STYLES.info}`}
                >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold">
                        {VARIANT_ICON[toast.variant] || VARIANT_ICON.info}
                    </span>
                    <p className="flex-1 leading-snug">{toast.message}</p>
                    <button
                        type="button"
                        onClick={() => dismiss(toast.id)}
                        className="shrink-0 text-white/50 hover:text-white"
                        aria-label="Dismiss notification"
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
