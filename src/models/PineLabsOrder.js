import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import User from './User.js';

const PineLabsOrder = sequelize.define('PineLabsOrder', {
    id: {
        type: DataTypes.BIGINT,
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
    merchantOrderRef: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true
    },
    pluralOrderId: {
        type: DataTypes.STRING(100),
        allowNull: true,
        unique: true
    },
    preAuth: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    // Stored in RUPEES with 2 decimals, matching PineLabsPayment.amount.
    // (This was INTEGER, which silently truncated fractional amounts on MySQL
    // and is rejected outright by Postgres.)
    amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false
    },
    currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'INR'
    },
    callbackUrl: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    failureCallbackUrl: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    notes: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    allowedPaymentMethods: {
        type: DataTypes.JSON,
        allowNull: true
    },
    customerId: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    customerEmail: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    pluralStatus: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    rawOrderResponse: {
        type: DataTypes.JSON,
        allowNull: true
    },
    cancelledAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    ipAddress: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'pine_labs_orders',
    timestamps: true
});

// Associations
User.hasMany(PineLabsOrder, { foreignKey: 'userId', as: 'PineLabsOrders', onDelete: 'CASCADE' });
PineLabsOrder.belongsTo(User, { foreignKey: 'userId', as: 'User' });

// Custom JSON serialization to rebrand references for client responses
PineLabsOrder.prototype.toJSON = function () {
    const values = { ...this.get() };

    if ('pluralOrderId' in values) {
        values.nxPayOrderId = values.pluralOrderId;
        delete values.pluralOrderId;
    }

    if ('pluralStatus' in values) {
        values.nxPayStatus = values.pluralStatus;
        delete values.pluralStatus;
    }

    if (values.PineLabsPayments) {
        values.nxPayPayments = values.PineLabsPayments;
        delete values.PineLabsPayments;
    }


    return values;
};

export default PineLabsOrder;
