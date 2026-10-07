import pkg from 'sequelize';

const { DataTypes } = pkg;

import sequelize from '../config/db.js';
import { jsonColumnGetter } from '../utils/jsonColumn.js';

const IdempotencyKey = sequelize.define(
    'IdempotencyKey',
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true
        },

        uuid: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            allowNull: false,
            unique: true
        },

        userId: {
            type: DataTypes.INTEGER,
            allowNull: false
        },

        scope: {
            type: DataTypes.STRING(150),
            allowNull: false
        },

        key: {
            type: DataTypes.STRING(255),
            allowNull: false
        },

        requestHash: {
            type: DataTypes.STRING(64),
            allowNull: false
        },

        status: {
            type: DataTypes.ENUM(
                'PROCESSING',
                'COMPLETED',
                'UNKNOWN'
            ),
            allowNull: false,
            defaultValue: 'PROCESSING'
        },

        responseStatus: {
            type: DataTypes.INTEGER,
            allowNull: true
        },

        responseBody: {
            type: DataTypes.JSON,
            allowNull: true,
            // Stored as text in this deployment: always hand back a parsed
            // object so an idempotent replay returns the original response.
            get: jsonColumnGetter('responseBody')
        },

        resourceId: {
            type: DataTypes.STRING(150),
            allowNull: true
        },

        lastError: {
            type: DataTypes.TEXT,
            allowNull: true
        },

        expiresAt: {
            type: DataTypes.DATE,
            allowNull: false
        }
    },
    {
        tableName: 'idempotency_keys',
        timestamps: true,

        indexes: [
            {
                unique: true,
                name: 'idempotency_user_scope_key_unique',
                fields: ['userId', 'scope', 'key']
            },
            {
                fields: ['expiresAt']
            },
            {
                fields: ['status']
            }
        ]
    }
);

export default IdempotencyKey;
