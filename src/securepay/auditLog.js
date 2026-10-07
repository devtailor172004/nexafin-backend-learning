import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';

/**
 * Writes a centralized audit log entry.
 * Never throws — an audit failure must not abort the business action,
 * but it is always logged loudly.
 */
export const writeAuditLog = async ({
    actorId = null,
    actorRole = null,
    action,
    entityType = null,
    entityId = null,
    description = null,
    before = null,
    after = null,
    ipAddress = null,
    metadata = null,
    transaction = null
}) => {
    try {
        return await AuditLog.create({
            actorId,
            actorRole,
            action,
            entityType,
            entityId,
            description,
            before,
            after,
            ipAddress,
            metadata
        }, { transaction });
    } catch (error) {
        logger.error(`Audit log write failed for action '${action}': ${error.message}`);
        return null;
    }
};

export default writeAuditLog;
