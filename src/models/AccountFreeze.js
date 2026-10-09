import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

/**
 * A temporary freeze on a synthetic retailer's money-moving capabilities.
 *
 * Freezing is always tied to a reason and an actor, and releasing requires an
 * authorised administrator to supply their own reason. Only ACTIVE rows block
 * operations; releasing a freeze keeps the historical record intact.
 */
const AccountFreeze = sequelize.define('AccountFreeze', {
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
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE'
    },
    // What exactly is frozen. ACCOUNT blocks every money-moving operation.
    scope: {
        type: DataTypes.ENUM('ACCOUNT', 'PAYOUT', 'WALLET'),
        allowNull: false,
        defaultValue: 'ACCOUNT'
    },
    status: {
        type: DataTypes.ENUM('ACTIVE', 'RELEASED'),
        allowNull: false,
        defaultValue: 'ACTIVE'
    },
    reason: {
        type: DataTypes.STRING(500),
        allowNull: false
    },
    sourceRiskEventId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    frozenById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    frozenAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    releasedById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
    },
    releasedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    releaseReason: {
        type: DataTypes.STRING(500),
        allowNull: true
    },
    correlationId: {
        type: DataTypes.STRING(80),
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    tableName: 'account_freezes',
    timestamps: true,
    indexes: [
        { fields: ['userId', 'status'] },
        { fields: ['scope', 'status'] },
        { fields: ['status', 'createdAt'] }
    ]
});

User.hasMany(AccountFreeze, { foreignKey: 'userId', as: 'Freezes', onDelete: 'CASCADE' });
AccountFreeze.belongsTo(User, { foreignKey: 'userId', as: 'User' });
AccountFreeze.belongsTo(User, { foreignKey: 'frozenById', as: 'FrozenBy' });
AccountFreeze.belongsTo(User, { foreignKey: 'releasedById', as: 'ReleasedBy' });

export default AccountFreeze;
