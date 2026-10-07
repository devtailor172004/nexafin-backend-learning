import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const PineLabsToken = sequelize.define('PineLabsToken', {
    id: {
        type: DataTypes.INTEGER,
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
        unique: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    clientId: {
        type: DataTypes.STRING,
        allowNull: false
    },
    accessToken: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    expiresAt: {
        type: DataTypes.DATE,
        allowNull: false
    },
    ipAddress: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'pine_labs_tokens',
    timestamps: true
});

// Associations
User.hasOne(PineLabsToken, { foreignKey: 'userId', as: 'PineLabsToken', onDelete: 'CASCADE' });
PineLabsToken.belongsTo(User, { foreignKey: 'userId', as: 'User' });

export default PineLabsToken;
