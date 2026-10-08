import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';
import ReconciliationRun from './ReconciliationRun.js';

/**
 * One reconciliation exception and its operations lifecycle:
 *
 *   OPEN -> INVESTIGATING -> RESOLVED
 *          \-> IGNORED
 *
 * Every transition is written to the audit log by the controller.
 */
const ReconciliationException = sequelize.define('ReconciliationException', {
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
    runId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        references: {
            model: 'reconciliation_runs',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    type: {
        type: DataTypes.ENUM(
            'AMOUNT_MISMATCH',
            'STATUS_MISMATCH',
            'MISSING_INTERNAL',
            'MISSING_PROVIDER',
            'DUPLICATE',
            'SETTLEMENT_MISMATCH'
        ),
        allowNull: false
    },
    severity: {
        type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH'),
        allowNull: false,
        defaultValue: 'MEDIUM'
    },
    provider: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'PINELABS'
    },
    matchKey: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    merchantPaymentReference: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    providerPaymentId: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    internalPaymentId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    internalOrderId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    expectedAmount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true
    },
    actualAmount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true
    },
    expectedStatus: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    actualStatus: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    amountDifference: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true
    },
    details: {
        type: DataTypes.JSON,
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM('OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED'),
        allowNull: false,
        defaultValue: 'OPEN'
    },
    assignedToId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'SET NULL'
    },
    resolutionNote: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    resolvedById: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    resolvedAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'reconciliation_exceptions',
    timestamps: true,
    indexes: [
        { fields: ['runId'] },
        { fields: ['status'] },
        { fields: ['type'] },
        { fields: ['severity'] },
        { fields: ['matchKey'] }
    ]
});

ReconciliationRun.hasMany(ReconciliationException, {
    foreignKey: 'runId',
    as: 'Exceptions',
    onDelete: 'CASCADE'
});
ReconciliationException.belongsTo(ReconciliationRun, { foreignKey: 'runId', as: 'Run' });

User.hasMany(ReconciliationException, { foreignKey: 'assignedToId', as: 'AssignedExceptions', onDelete: 'SET NULL' });
ReconciliationException.belongsTo(User, { foreignKey: 'assignedToId', as: 'AssignedTo' });

export default ReconciliationException;
