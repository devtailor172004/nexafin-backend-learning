import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import PineLabsOrder from './PineLabsOrder.js';
import PineLabsPayment from './PineLabsPayment.js';

/**
 * Append-only payment timeline.
 *
 * Every meaningful thing that happens to an order or a payment is written
 * here: order created, provider called, webhook received, state transitioned,
 * transition rejected, refund requested, etc.
 *
 * This table powers:
 *   - GET /api/securepay/payments/:uuid/timeline
 *   - GET /api/securepay/payments/:uuid/explain  ("why did this fail?")
 */
const PaymentEvent = sequelize.define('PaymentEvent', {
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
    orderId: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        references: {
            model: 'pine_labs_orders',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    paymentId: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        references: {
            model: 'pine_labs_payments',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    // Internal event name from the event catalog (PAYMENT_AUTHORIZED, ...)
    eventType: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    // Raw provider event name that caused this, when applicable
    providerEventType: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    source: {
        type: DataTypes.ENUM('API', 'WEBHOOK', 'CALLBACK', 'STATE_MACHINE', 'SYSTEM', 'ADMIN'),
        allowNull: false,
        defaultValue: 'SYSTEM'
    },
    statusFrom: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    statusTo: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    message: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    // true when a transition was rejected by the state machine
    isRejected: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    actorId: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    provider: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'PINELABS'
    },
    providerEventId: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    tableName: 'payment_events',
    timestamps: true,
    indexes: [
        { fields: ['orderId', 'createdAt'] },
        { fields: ['paymentId', 'createdAt'] },
        { fields: ['eventType'] },
        { fields: ['createdAt'] }
    ]
});

PineLabsOrder.hasMany(PaymentEvent, { foreignKey: 'orderId', as: 'PaymentEvents', onDelete: 'CASCADE' });
PaymentEvent.belongsTo(PineLabsOrder, { foreignKey: 'orderId', as: 'Order' });

PineLabsPayment.hasMany(PaymentEvent, { foreignKey: 'paymentId', as: 'PaymentEvents', onDelete: 'CASCADE' });
PaymentEvent.belongsTo(PineLabsPayment, { foreignKey: 'paymentId', as: 'Payment' });

export default PaymentEvent;
