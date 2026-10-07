import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const Director = sequelize.define('Director', {
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
    director_name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    aadharcard: {
        type: DataTypes.STRING,
        allowNull: true
    },
    aadharcard_verification_status: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'pending'
    },
    digilocker_reference_key: {
        type: DataTypes.STRING,
        allowNull: true
    },
    pan_verification_status: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'pending'
    },
    pancard: {
        type: DataTypes.STRING,
        allowNull: true
    },
    dob: {
        type: DataTypes.STRING,
        allowNull: true
    },
    din_number: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: {
            isNumeric: {
                msg: "DIN number must be numeric."
            },
            len: {
                args: [8, 8],
                msg: "DIN number must be exactly 8 digits."
            }
        }
    },
    doj: {
        type: DataTypes.STRING,
        allowNull: true
    },
    surrendered_din: {
        type: DataTypes.STRING,
        defaultValue: 'No',
        allowNull: false
    },
    cin: {
        type: DataTypes.STRING,
        allowNull: true
    },
    partnership_percentage: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },
    aadharcard_front_url: {
        type: DataTypes.STRING,
        allowNull: true
    },
    aadharcard_back_url: {
        type: DataTypes.STRING,
        allowNull: true
    },
    pancard_url: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'directors',
    timestamps: true,
    indexes: [
        {
            unique: true,
            fields: ['userId', 'din_number'],
            name: 'user_director_din_unique'
        },
        { fields: ['userId', 'createdAt'] },
        { fields: ['cin', 'createdAt'] },
        { fields: ['din_number'] }
    ]
});

// Associations
User.hasMany(Director, { foreignKey: 'userId', as: 'Directors', onDelete: 'CASCADE' });
Director.belongsTo(User, { foreignKey: 'userId', as: 'User' });



export default Director;
