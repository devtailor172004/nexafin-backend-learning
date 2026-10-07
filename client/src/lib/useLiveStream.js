import { useEffect, useRef, useState } from 'react';
import { getToken } from './api.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const MAX_EVENTS = 200;

/**
 * Subscribes to GET /api/securepay/stream via Server-Sent Events.
 *
 * EventSource cannot send an Authorization header, so the JWT is passed as a
 * query parameter (the endpoint authenticates and enforces the Admin role).
 */
export function useLiveStream({ enabled = true } = {}) {
    const [events, setEvents] = useState([]);
    const [status, setStatus] = useState('idle');
    const [error, setError] = useState(null);
    const sourceRef = useRef(null);

    useEffect(() => {
        if (!enabled) return undefined;

        const token = getToken();
        if (!token) {
            setStatus('error');
            setError('No session token available.');
            return undefined;
        }

        const url = `${API_BASE}/api/securepay/stream?token=${encodeURIComponent(token)}`;
        const source = new EventSource(url);
        sourceRef.current = source;
        setStatus('connecting');

        const onConnected = (event) => {
            setStatus('connected');
            setError(null);
            try {
                const data = JSON.parse(event.data);
                if (data?.message) {
                    setEvents((prev) => [{ id: `conn-${Date.now()}`, kind: 'connection', message: data.message, at: data.at }, ...prev].slice(0, MAX_EVENTS));
                }
            } catch {
                // ignore malformed frame
            }
        };

        const onPaymentEvent = (event) => {
            try {
                const data = JSON.parse(event.data);
                setEvents((prev) => {
                    if (data?.id && prev.some((item) => item.id === data.id)) return prev;
                    return [data, ...prev].slice(0, MAX_EVENTS);
                });
            } catch {
                // ignore malformed frame
            }
        };

        const onError = () => {
            setStatus('reconnecting');
            setError('Live stream interrupted. Retrying…');
        };

        source.addEventListener('connected', onConnected);
        source.addEventListener('payment.event', onPaymentEvent);
        source.onerror = onError;

        return () => {
            source.removeEventListener('connected', onConnected);
            source.removeEventListener('payment.event', onPaymentEvent);
            source.close();
            sourceRef.current = null;
            setStatus('idle');
        };
    }, [enabled]);

    return { events, status, error, clear: () => setEvents([]) };
}
