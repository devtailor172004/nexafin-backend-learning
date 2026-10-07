import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const UserIp = sequelize.define('UserIp', {
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
        unique: 'user_ip_unique',
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    ipAddress: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: 'user_ip_unique'
    },
    status: {
        type: DataTypes.ENUM('approved', 'not approved'),
        defaultValue: 'not approved',
        allowNull: false
    }
}, {
    tableName: 'user_ips',
    timestamps: true,
    indexes: [
        { fields: ['status', 'createdAt'] }
    ]
});

// Associations
User.hasMany(UserIp, { foreignKey: 'userId', as: 'UserIps', onDelete: 'CASCADE' });
UserIp.belongsTo(User, { foreignKey: 'userId', as: 'User' });



export default UserIp;
