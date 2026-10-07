import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';

const BlacklistedToken = sequelize.define('BlacklistedToken', {
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
    token: {
        type: DataTypes.STRING(512),
        allowNull: false
    },
    expiresAt: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'blacklisted_tokens',
    timestamps: true,
    indexes: [
        { fields: ['token'], length: 255 }
    ]
});



export default BlacklistedToken;
