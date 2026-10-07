import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';

const Otp = sequelize.define('Otp', {
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
    email: {
        type: DataTypes.STRING,
        allowNull: false
    },
    otp: {
        type: DataTypes.STRING(6),
        allowNull: false
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'otps',
    timestamps: true,
    indexes: [
        { fields: ['email'] }
    ]
});



export default Otp;
