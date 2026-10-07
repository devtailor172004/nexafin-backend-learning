import crypto from 'crypto';
import pkg from 'sequelize';

const { UniqueConstraintError } = pkg;

import IdempotencyKey from '../models/IdempotencyKey.js';
import { ApiError } from './ApiError.js';
import { HTTP_STATUS } from './httpStatus.js';

/*
 * Exported so the hashing rules can be unit tested without touching the
 * database (see tests/idempotency.test.js).
 */
export const stableStringify = value => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }

    return `{${Object.keys(value)
        .sort()
        .map(
            key =>
                `${JSON.stringify(key)}:${stableStringify(value[key])}`
        )
        .join(',')}}`;
};

export const buildRequestHash = req => {
    const payload = {
        method: req.method,
        path: req.originalUrl,
        params: req.params,
        query: req.query,
        body: req.body
    };

    return crypto
        .createHash('sha256')
        .update(stableStringify(payload))
        .digest('hex');
};

export const claimIdempotency = async ({
    req,
    userId,
    scope,
    ttlMs = 24 * 60 * 60 * 1000
}) => {
    const key = req.get('Idempotency-Key')?.trim();

    if (!key) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'Idempotency-Key header is required.'
        );
    }

    if (key.length < 8 || key.length > 255) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            'Idempotency-Key must be between 8 and 255 characters.'
        );
    }

    const requestHash = buildRequestHash(req);

    let existing =
        await IdempotencyKey.findOne({
            where: {
                userId,
                scope,
                key
            }
        });

    // Expired record can be safely replaced.
    if (
        existing &&
        new Date(existing.expiresAt).getTime() <
            Date.now()
    ) {
        await existing.destroy();
        existing = null;
    }

    if (existing) {
        /*
         * Same key but different request = reject.
         */
        if (existing.requestHash !== requestHash) {
            throw new ApiError(
                HTTP_STATUS.CONFLICT,
                'This Idempotency-Key was already used with a different request.'
            );
        }

        if (existing.status === 'COMPLETED') {
            return {
                replay: true,
                record: existing,
                responseStatus: existing.responseStatus,
                responseBody: existing.responseBody
            };
        }

        if (existing.status === 'UNKNOWN') {
            throw new ApiError(
                HTTP_STATUS.CONFLICT,
                'Previous request outcome is unknown. Check transaction status before retrying.'
            );
        }

        throw new ApiError(
            HTTP_STATUS.CONFLICT,
            'A request with this Idempotency-Key is already being processed.'
        );
    }

    try {
        const record =
            await IdempotencyKey.create({
                userId,
                scope,
                key,
                requestHash,
                status: 'PROCESSING',
                expiresAt: new Date(
                    Date.now() + ttlMs
                )
            });

        return {
            replay: false,
            record,
            responseStatus: null,
            responseBody: null
        };
    } catch (error) {
        /*
         * Two simultaneous requests can race here.
         * The DB unique constraint is the final protection.
         */
        if (error instanceof UniqueConstraintError) {
            const raced =
                await IdempotencyKey.findOne({
                    where: {
                        userId,
                        scope,
                        key
                    }
                });

            if (!raced) {
                throw error;
            }

            if (
                raced.requestHash !==
                requestHash
            ) {
                throw new ApiError(
                    HTTP_STATUS.CONFLICT,
                    'This Idempotency-Key was already used with a different request.'
                );
            }

            if (raced.status === 'COMPLETED') {
                return {
                    replay: true,
                    record: raced,
                    responseStatus:
                        raced.responseStatus,
                    responseBody:
                        raced.responseBody
                };
            }

            throw new ApiError(
                HTTP_STATUS.CONFLICT,
                'A request with this Idempotency-Key is already being processed.'
            );
        }

        throw error;
    }
};

export const markIdempotencyCompleted = async (
    record,
    {
        statusCode,
        responseBody,
        resourceId = null
    }
) => {
    record.status = 'COMPLETED';
    record.responseStatus = statusCode;
    record.responseBody = responseBody;
    record.resourceId = resourceId;
    record.lastError = null;

    await record.save();
};

export const markIdempotencyUnknown = async (
    record,
    errorMessage
) => {
    try {
        record.status = 'UNKNOWN';
        record.lastError =
            String(errorMessage || 'Unknown error').slice(
                0,
                2000
            );

        await record.save();
    } catch {
        // Never hide the original operation error.
    }
};
