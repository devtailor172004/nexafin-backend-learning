import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

/**
 * A persisted fraud-risk evaluation.
 *
 * Every money-moving attempt that the engine scores is stored here — including
 * ALLOW decisions — so the Security Center can show real counts rather than
 * fabricated ones, and so an investigation can reconstruct what the engine saw.
 *
 * The row is the durable source of truth for holds: a HOLD/BLOCK that is still
 * OPEN keeps the account's restricted operations blocked until an administrator
 * reviews it (see `fraudService.reviewRiskEvent`).
 */
const RiskEvent = sequelize.define('RiskEvent', {
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
    userId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    // Stable business reference (payment/order/payout uuid) — not a DB id.
    transactionId: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    operation: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: 'PAYOUT'
    },
    amountMinor: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
    },
    currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'INR'
    },
    riskScore: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    riskLevel: {
        type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'),
        allowNull: false,
        defaultValue: 'LOW'
    },
    decision: {
        type: DataTypes.ENUM('ALLOW', 'STEP_UP', 'HOLD', 'BLOCK'),
        allowNull: false,
        defaultValue: 'ALLOW'
    },
    rulesTriggered: {
        type: DataTypes.JSON,
        allowNull: true
    },
    explanations: {
        type: DataTypes.JSON,
        allowNull: true
    },
    configVersion: {
        type: DataTypes.STRING(20),
        allowNull: true
    },
    // Review workflow. HOLD/BLOCK events start OPEN and keep the restriction live.
    status: {
        type: DataTypes.ENUM('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'),
        allowNull: false,
        defaultValue: 'OPEN'
    },
    reviewedById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    reviewDecision: {
        type: DataTypes.ENUM('CONFIRM', 'RELEASE', 'ESCALATE'),
        allowNull: true
    },
    reviewReason: {
        type: DataTypes.STRING(500),
        allowNull: true
    },
    reviewedAt: {
        type: DataTypes.DATE,
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
    ipAddress: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    incidentId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    tableName: 'risk_events',
    timestamps: true,
    indexes: [
        { fields: ['userId', 'createdAt'] },
        { fields: ['decision', 'status'] },
        { fields: ['riskLevel'] },
        { fields: ['createdAt'] },
        { fields: ['correlationId'] },
        { fields: ['incidentId'] }
    ]
});

User.hasMany(RiskEvent, { foreignKey: 'userId', as: 'RiskEvents', onDelete: 'SET NULL' });
RiskEvent.belongsTo(User, { foreignKey: 'userId', as: 'User' });
RiskEvent.belongsTo(User, { foreignKey: 'reviewedById', as: 'ReviewedBy' });

export default RiskEvent;
