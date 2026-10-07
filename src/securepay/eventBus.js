import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

/**
 * In-process live event bus.
 *
 * Payment events are published here and streamed to connected clients via
 * Server-Sent Events (GET /api/securepay/stream). A small ring buffer keeps
 * the most recent events so a client that reconnects can immediately render
 * a backlog instead of an empty feed.
 *
 * NOTE: this is single-process. For multi-instance deployments, swap the
 * transport for Redis pub/sub behind the same publish/subscribe API.
 */

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const LIVE_EVENT = 'securepay:live';

const REPLAY_BUFFER_SIZE = 100;
const replayBuffer = [];

/**
 * Publish a live event to all subscribers.
 * Never throws — observability must not break a payment flow.
 */
export const publishLiveEvent = (payload) => {
    const event = {
        id: payload.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: payload.at || new Date().toISOString(),
        ...payload
    };

    replayBuffer.push(event);
    if (replayBuffer.length > REPLAY_BUFFER_SIZE) {
        replayBuffer.shift();
    }

    try {
        emitter.emit(LIVE_EVENT, event);
    } catch (error) {
        logger.warn(`Live event publish failed: ${error.message}`);
    }

    return event;
};

export const subscribeLiveEvents = (handler) => {
    emitter.on(LIVE_EVENT, handler);
    return () => emitter.off(LIVE_EVENT, handler);
};

/** Most recent events, oldest first. */
export const getRecentLiveEvents = (limit = 25) => {
    const safeLimit = Math.max(1, Math.min(REPLAY_BUFFER_SIZE, Number(limit) || 25));
    return replayBuffer.slice(-safeLimit);
};

export const getLiveSubscriberCount = () => emitter.listenerCount(LIVE_EVENT);
