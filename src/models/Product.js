import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const Product = sequelize.define('Product', {
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
        unique: 'user_product_unique',
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    product_name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: 'user_product_unique'
    },
    status: {
        type: DataTypes.ENUM('active', 'deactive', 'pending'),
        defaultValue: 'deactive',
        allowNull: false
    }
}, {
    tableName: 'products',
    timestamps: true,
    indexes: [
        { fields: ['status', 'updatedAt'] },
        { fields: ['userId', 'product_name'] },
        { fields: ['userId', 'status'] }
    ]
});

// Associations
User.hasMany(Product, { foreignKey: 'userId', as: 'Products', onDelete: 'CASCADE' });
Product.belongsTo(User, { foreignKey: 'userId', as: 'User' });



export default Product;
