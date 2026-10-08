import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

/**
 * A single reconciliation run: internal ledger vs provider report.
 *
 * `source` records where the provider report came from. SIMULATED is used when
 * no real provider report is available — it is stored explicitly so a run is
 * never mistaken for a settlement against a real provider file.
 */
const ReconciliationRun = sequelize.define('ReconciliationRun', {
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
    provider: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'PINELABS'
    },
    periodStart: {
        type: DataTypes.DATE,
        allowNull: false
    },
    periodEnd: {
        type: DataTypes.DATE,
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('RUNNING', 'COMPLETED', 'FAILED'),
        allowNull: false,
        defaultValue: 'RUNNING'
    },
    // PROVIDER_REPORT = a real file/API, SIMULATED = generated for testing
    source: {
        type: DataTypes.ENUM('PROVIDER_REPORT', 'SIMULATED'),
        allowNull: false,
        defaultValue: 'SIMULATED'
    },
    internalCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    providerCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    matchedCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    exceptionCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    summary: {
        type: DataTypes.JSON,
        allowNull: true
    },
    injected: {
        type: DataTypes.JSON,
        allowNull: true
    },
    errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    triggeredById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'SET NULL'
    },
    startedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    completedAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'reconciliation_runs',
    timestamps: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['provider', 'createdAt'] },
        { fields: ['periodStart', 'periodEnd'] }
    ]
});

User.hasMany(ReconciliationRun, { foreignKey: 'triggeredById', as: 'ReconciliationRuns', onDelete: 'SET NULL' });
ReconciliationRun.belongsTo(User, { foreignKey: 'triggeredById', as: 'TriggeredBy' });

export default ReconciliationRun;
