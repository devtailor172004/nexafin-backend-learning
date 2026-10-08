import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import { jsonColumnGetter } from '../utils/jsonColumn.js';

/**
 * Provider webhook event ledger.
 *
 * Every inbound provider webhook is recorded here BEFORE it is applied to
 * business tables. `UNIQUE(provider, webhookId)` is the deduplication guard:
 * providers retry webhooks aggressively and the business state must be
 * applied exactly once.
 *
 * Only a SANITIZED payload is stored (never the full raw provider body) so
 * the database does not accumulate huge or sensitive provider debug data.
 */
const ProviderWebhookEvent = sequelize.define('ProviderWebhookEvent', {
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
    provider: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'PINELABS'
    },
    // Provider supplied webhook id (from the webhook-id header). A synthetic
    // value is used for local mock webhooks so dedupe still works.
    webhookId: {
        type: DataTypes.STRING(150),
        allowNull: false
    },
    eventType: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    internalEvent: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    providerOrderId: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    providerPaymentId: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    localOrderId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    localPaymentId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    webhookTimestamp: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    signatureVerified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    // RECEIVED -> PROCESSING -> PROCESSED | FAILED | IGNORED
    status: {
        type: DataTypes.ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'),
        allowNull: false,
        defaultValue: 'RECEIVED'
    },
    attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    isMock: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    sanitizedPayload: {
        type: DataTypes.JSON,
        allowNull: true,
        get: jsonColumnGetter('sanitizedPayload')
    },
    errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    receivedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    processedAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'provider_webhook_events',
    timestamps: true,
    indexes: [
        {
            name: 'provider_webhook_events_provider_webhook_id_unique',
            unique: true,
            fields: ['provider', 'webhookId']
        },
        { fields: ['status'] },
        { fields: ['providerOrderId'] },
        { fields: ['eventType'] },
        { fields: ['createdAt'] }
    ]
});

export const WEBHOOK_EVENT_STATUS = Object.freeze({
    RECEIVED: 'RECEIVED',
    PROCESSING: 'PROCESSING',
    PROCESSED: 'PROCESSED',
    FAILED: 'FAILED',
    IGNORED: 'IGNORED'
});

export default ProviderWebhookEvent;
