import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

/**
 * Centralized audit log for privileged / sensitive actions.
 *
 * Used for admin actions (KYC approve/reject), reconciliation resolutions,
 * provider credential changes and any state mutation that must be traceable.
 */
const AuditLog = sequelize.define('AuditLog', {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true
    },
    uuid: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        allowNull: true,
        unique: true
    },
    actorId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'SET NULL'
    },
    actorRole: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    action: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    entityType: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    entityId: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    before: {
        type: DataTypes.JSON,
        allowNull: true
    },
    after: {
        type: DataTypes.JSON,
        allowNull: true
    },
    ipAddress: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    },

    // ---- Security-relevant outcome metadata (Feature Six) ----
    outcome: {
        type: DataTypes.STRING(30),
        allowNull: true
    },
    reason: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    source: {
        type: DataTypes.STRING(40),
        allowNull: true
    },
    correlationId: {
        type: DataTypes.STRING(80),
        allowNull: true
    },
    requestId: {
        type: DataTypes.STRING(80),
        allowNull: true
    },

    // ---- Tamper-evident hash chain (Feature Six) ----
    // Records written before the chain existed have a NULL sequence; the
    // verifier simply starts at the first chained row. `unique` prevents two
    // writers from claiming the same position in the log.
    sequence: {
        type: DataTypes.BIGINT,
        allowNull: true,
        unique: true
    },
    prevHash: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    hash: {
        type: DataTypes.STRING(64),
        allowNull: true
    }
}, {
    tableName: 'audit_logs',
    timestamps: true,
    indexes: [
        { fields: ['actorId', 'createdAt'] },
        { fields: ['action'] },
        { fields: ['entityType', 'entityId'] },
        { fields: ['createdAt'] },
        { fields: ['sequence'], unique: true },
        { fields: ['outcome'] },
        { fields: ['correlationId'] }
    ]
});

User.hasMany(AuditLog, { foreignKey: 'actorId', as: 'AuditLogs', onDelete: 'SET NULL' });
AuditLog.belongsTo(User, { foreignKey: 'actorId', as: 'Actor' });

export default AuditLog;
