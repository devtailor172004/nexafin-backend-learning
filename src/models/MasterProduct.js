import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';

const MasterProduct = sequelize.define('MasterProduct', {
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
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    display_name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM('active', 'deactive'),
        defaultValue: 'active',
        allowNull: false
    }
}, {
    tableName: 'master_products',
    timestamps: true
});



export default MasterProduct;
