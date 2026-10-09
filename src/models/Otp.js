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
    // Deprecated plaintext column. Never populated any more — only `otpHash` is
    // written. Kept nullable for compatibility with existing rows.
    otp: {
        type: DataTypes.STRING(6),
        allowNull: true
    },
    // bcrypt hash of the verification code. Plaintext codes are never stored.
    otpHash: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    purpose: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: 'PASSWORD_RESET'
    },
    attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    maxAttempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 5
    },
    consumedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'otps',
    timestamps: true,
    indexes: [
        { fields: ['email'] },
        { fields: ['email', 'purpose'] }
    ]
});



export default Otp;
