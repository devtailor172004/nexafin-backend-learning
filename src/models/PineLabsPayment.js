import pkg from 'sequelize';

const { DataTypes } = pkg;

import sequelize from '../config/db.js';
import PineLabsOrder from './PineLabsOrder.js';

const PineLabsPayment = sequelize.define(
    'PineLabsPayment',
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true
        },

        uuid: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            allowNull: true,
            unique: true
        },

        // Local order ID
        orderId: {
            type: DataTypes.BIGINT.UNSIGNED,
            allowNull: false,
            references: {
                model: 'pine_labs_orders',
                key: 'id'
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },

        // NxPay Order ID
        nxPayOrderId: {
            type: DataTypes.STRING(100),
            allowNull: true
        },

        // NxPay Payment ID
        nxPayPaymentId: {
            type: DataTypes.STRING(100),
            allowNull: true,
            unique: true
        },

        // Unique merchant payment reference
        merchantPaymentReference: {
            type: DataTypes.STRING(100),
            allowNull: false,
            unique: true
        },

        amount: {
            type: DataTypes.DECIMAL(12, 2),
            allowNull: false
        },

        currency: {
            type: DataTypes.STRING(3),
            allowNull: false,
            defaultValue: 'INR'
        },

        // CARD, UPI, or NETBANKING
        paymentMethod: {
            type: DataTypes.ENUM('CARD', 'UPI', 'NETBANKING'),
            allowNull: false,
            defaultValue: 'CARD'
        },

        // Mirrors src/securepay/stateMachine.js PAYMENT_STATUS. The reconcile
        // script (src/config/syncDb.js) will ALTER the ENUM when values change.
        status: {
            type: DataTypes.ENUM(
                'CREATED',
                'PENDING',
                'AUTHORIZED',
                'PROCESSED',
                'CANCELLED',
                'FAILED',
                'EXPIRED',
                'REFUND_PENDING',
                'REFUNDED',
                'REFUND_FAILED'
            ),
            allowNull: false,
            defaultValue: 'PENDING'
        },

        // Pine Labs return URL signature
        signature: {
            type: DataTypes.STRING(255),
            allowNull: true
        },

        // Signature verification status
        isSignatureVerified: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false
        },

        // Error details received on failed callback
        errorCode: {
            type: DataTypes.STRING(100),
            allowNull: true
        },

        errorMessage: {
            type: DataTypes.TEXT,
            allowNull: true
        },

        // Common Pine Labs challenge URL
        challengeUrl: {
            type: DataTypes.TEXT,
            allowNull: true
        },

        responseCode: {
            type: DataTypes.STRING(50),
            allowNull: true
        },

        responseMessage: {
            type: DataTypes.STRING(255),
            allowNull: true
        },

        transactionId: {
            type: DataTypes.STRING(100),
            allowNull: true
        },

        // =========================
        // CARD PAYMENT DETAILS
        // =========================

        // 3DS version
        threeDsVersion: {
            type: DataTypes.STRING(50),
            allowNull: true
        },

        authenticationType: {
            type: DataTypes.STRING(50),
            allowNull: true
        },

        eci: {
            type: DataTypes.STRING(50),
            allowNull: true
        },

        // Store only non-sensitive card information
        card: {
            type: DataTypes.JSON,
            allowNull: true
        },

        // =========================
        // UPI PAYMENT DETAILS
        // =========================

        /*
        Example:

        {
            txnMode: "INTENT",
            intentUrl: "...",
            qrImageUrl: "...",
            vpa: "user@upi"
        }
        */
        upi: {
            type: DataTypes.JSON,
            allowNull: true
        },

        // =========================
        // NETBANKING PAYMENT DETAILS
        // =========================

        /*
        Example:

        {
            payCode: "NB1531",
            txnMode: "REDIRECT",
            challengeUrl: "https://..."
        }
        */
        netbanking: {
            type: DataTypes.JSON,
            allowNull: true
        },

        // =========================
        // COMMON PAYMENT DETAILS
        // =========================

        // Pine Labs acquirer information
        acquirer: {
            type: DataTypes.JSON,
            allowNull: true
        },

        merchantCaptureReference: {
            type: DataTypes.STRING(100),
            allowNull: true,
            unique: true
        },

        captureAmount: {
            type: DataTypes.INTEGER,
            allowNull: true
        },

        captureCurrency: {
            type: DataTypes.STRING(3),
            allowNull: true
        },

        captureData: {
            type: DataTypes.JSON,
            allowNull: true
        },

        capturedAt: {
            type: DataTypes.DATE,
            allowNull: true
        },

        // Sanitized Pine Labs API response
        rawResponse: {
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
    },
    {
        tableName: 'pine_labs_payments',

        timestamps: true,

        indexes: [
            {
                fields: ['orderId']
            },
            {
                fields: ['nxPayOrderId']
            },
            {
                fields: ['nxPayPaymentId']
            },
            {
                fields: ['paymentMethod']
            },
            {
                fields: ['status']
            }
        ]
    }
);

// =========================
// ASSOCIATIONS
// =========================

PineLabsOrder.hasMany(PineLabsPayment, {
    foreignKey: 'orderId',
    as: 'PineLabsPayments',
    onDelete: 'CASCADE'
});

PineLabsPayment.belongsTo(PineLabsOrder, {
    foreignKey: 'orderId',
    as: 'PineLabsOrder'
});

// Custom JSON serialization to rebrand references for client responses
PineLabsPayment.prototype.toJSON = function () {
    const values = { ...this.get() };

    if (values.PineLabsOrder) {
        values.NxPayOrder = values.PineLabsOrder;
        delete values.PineLabsOrder;
    }

    return values;
};

export default PineLabsPayment;
