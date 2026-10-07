import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const ProductToken = sequelize.define('ProductToken', {
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
        allowNull: true,
        unique: true
    },
    clientSecret: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'product_tokens',
    timestamps: true
});

// Associations
User.hasOne(ProductToken, { foreignKey: 'userId', as: 'ProductToken', onDelete: 'CASCADE' });
ProductToken.belongsTo(User, { foreignKey: 'userId', as: 'User' });



export default ProductToken;
