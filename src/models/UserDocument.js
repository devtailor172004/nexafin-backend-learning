import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const UserDocument = sequelize.define('UserDocument', {
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
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    business_type: {
        type: DataTypes.STRING,
        allowNull: false
    },
    document_type: {
        type: DataTypes.STRING,
        allowNull: false
    },
    document_url: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('pending', 'verified', 'rejected'),
        allowNull: false,
        defaultValue: 'pending'
    },
    rejection_reason: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null
    }
}, {
    tableName: 'user_documents',
    timestamps: true,
    indexes: [
        {
            unique: true,
            fields: ['userId', 'document_type'],
            name: 'user_document_unique'
        },
        { fields: ['userId', 'createdAt'] },
        { fields: ['status'] }
    ]
});

// Associations
UserDocument.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(UserDocument, { foreignKey: 'userId', as: 'documents' });



export default UserDocument;
