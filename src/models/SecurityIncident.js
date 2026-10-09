import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

/**
 * A security incident groups related risk events into one investigable case.
 *
 * The ordered timeline the frontend shows is assembled from `RiskEvent`,
 * `AccountFreeze` and the hash-chained `AuditLog` rows sharing this incident's
 * correlation id — the incident row itself only holds the case summary.
 */
const SecurityIncident = sequelize.define('SecurityIncident', {
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
    title: {
        type: DataTypes.STRING(200),
        allowNull: false
    },
    description: {
        type: DataTypes.STRING(1000),
        allowNull: true
    },
    severity: {
        type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'),
        allowNull: false,
        defaultValue: 'MEDIUM'
    },
    status: {
        type: DataTypes.ENUM('OPEN', 'INVESTIGATING', 'CLOSED'),
        allowNull: false,
        defaultValue: 'OPEN'
    },
    primaryUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    riskEventIds: {
        type: DataTypes.JSON,
        allowNull: true
    },
    correlationId: {
        type: DataTypes.STRING(80),
        allowNull: true
    },
    openedById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    closedById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    closedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    closureReason: {
        type: DataTypes.STRING(500),
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    tableName: 'security_incidents',
    timestamps: true,
    indexes: [
        { fields: ['status', 'createdAt'] },
        { fields: ['severity'] },
        { fields: ['primaryUserId'] },
        { fields: ['correlationId'] }
    ]
});

User.hasMany(SecurityIncident, { foreignKey: 'primaryUserId', as: 'Incidents', onDelete: 'SET NULL' });
SecurityIncident.belongsTo(User, { foreignKey: 'primaryUserId', as: 'PrimaryUser' });
SecurityIncident.belongsTo(User, { foreignKey: 'openedById', as: 'OpenedBy' });
SecurityIncident.belongsTo(User, { foreignKey: 'closedById', as: 'ClosedBy' });

export default SecurityIncident;
