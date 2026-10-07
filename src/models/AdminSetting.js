import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';

const AdminSetting = sequelize.define('AdminSetting', {
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
    key: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    value: {
        type: DataTypes.STRING,
        allowNull: false
    }
}, {
    tableName: 'admin_settings',
    timestamps: true
});



export default AdminSetting;
