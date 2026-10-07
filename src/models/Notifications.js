import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const Notification = sequelize.define('Notification', {
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
    title: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            notEmpty: { msg: "Notification title is required." }
        }
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
            notEmpty: { msg: "Notification message is required." }
        }
    },
    type: {
        type: DataTypes.ENUM('info', 'warning', 'success', 'danger', 'general'),
        defaultValue: 'info'
    },
    send_to: {
        type: DataTypes.ENUM('all', 'specific', 'product'),
        defaultValue: 'all'
    },
    product_name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    created_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'SET NULL'
    },
    status: {
        type: DataTypes.ENUM('active', 'inactive'),
        defaultValue: 'active'
    }
}, {
    tableName: 'notifications',
    timestamps: true,
    indexes: [
        { fields: ['status', 'createdAt'] },
        { fields: ['send_to', 'userId', 'status'] },
        { fields: ['send_to', 'product_name', 'status'] }
    ]
});

// Associations
User.hasMany(Notification, { foreignKey: 'userId', as: 'Notifications', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'userId', as: 'User' });
Notification.belongsTo(User, { foreignKey: 'created_by', as: 'Creator' });

export default Notification;
