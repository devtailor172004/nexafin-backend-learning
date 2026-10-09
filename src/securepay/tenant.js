import { ApiError } from '../utils/ApiError.js';
import { HTTP_STATUS } from '../utils/httpStatus.js';

/**
 * Tenant isolation / BOLA protection helpers.
 *
 * The single rule this module enforces: **ownership is decided from the
 * authenticated identity, never from anything the client supplies.** A request
 * cannot gain access to another tenant's data by changing a resource id, a
 * `userId` body field or a `tenantId` query param.
 *
 * Route handlers are expected to call `assertResourceOwner` (or `resolveTenantId`
 * plus an ownership-scoped query) rather than trusting `req.params`/`req.body`.
 */

/**
 * The authenticated tenant id. Only ever derived from `req.user`.
 * @throws {ApiError} 401 when unauthenticated
 */
export const resolveTenantId = (req) => {
    const id = Number(req?.user?.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED || 401, 'Authentication required.');
    }
    return id;
};

export const isAdmin = (req) => req?.user?.role === 'Admin';

/** True when the authenticated user is an administrator. */
export const assertAdmin = (req) => {
    if (!isAdmin(req)) {
        throw new ApiError(HTTP_STATUS.FORBIDDEN || 403, 'Administrator privileges are required.');
    }
    return true;
};

/**
 * Asserts that the authenticated actor owns the resource.
 *
 * @param {object} params
 * @param {number} params.actorId   authenticated user id (from req.user)
 * @param {number} params.ownerId   the resource's owning user id (from the DB)
 * @param {string} [params.resourceType]
 * @param {boolean} [params.discloseExistence] when false, deny with 404 so the
 *        response does not reveal that the resource exists
 * @throws {ApiError} 404 when the resource has no owner, 403/404 when denied
 */
export const assertResourceOwner = ({ actorId, ownerId, resourceType = 'Resource', discloseExistence = true }) => {
    const actor = Number(actorId);
    if (!Number.isInteger(actor) || actor <= 0) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED || 401, 'Authentication required.');
    }

    if (ownerId === null || ownerId === undefined) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, `${resourceType} not found.`);
    }

    if (Number(ownerId) !== actor) {
        if (discloseExistence) {
            throw new ApiError(HTTP_STATUS.FORBIDDEN || 403, `You are not allowed to access this ${resourceType.toLowerCase()}.`);
        }
        throw new ApiError(HTTP_STATUS.NOT_FOUND || 404, `${resourceType} not found.`);
    }

    return true;
};

/**
 * Builds the ownership filter for a tenant-scoped query. Admin-only endpoints
 * bypass this deliberately — everything else must scope by the returned id.
 */
export const tenantScope = (req, { allowAdmin = false } = {}) => {
    if (allowAdmin && isAdmin(req)) return {};
    return { userId: resolveTenantId(req) };
};

export default assertResourceOwner;
