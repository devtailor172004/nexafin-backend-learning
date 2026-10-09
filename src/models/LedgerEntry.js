import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';
import LedgerAccount from './LedgerAccount.js';

/**
 * An immutable, append-only double-entry posting.
 *
 * Entries are never updated or deleted; the model hooks reject both. A mistake
 * is corrected by posting a compensating journal, which keeps the original
 * entries — and therefore the audit trail — intact.
 *
 * Invariant enforced by the ledger service (not by this model, which cannot see
 * the other rows in the journal): for every `journalId`, the sum of DEBIT
 * amounts equals the sum of CREDIT amounts.
 */
const LedgerEntry = sequelize.define('LedgerEntry', {
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
    // All entries of one balanced journal share this id.
    journalId: {
        type: DataTypes.UUID,
        allowNull: false
    },
    // Immutable business reference (payment uuid, payout uuid, reversal id ...).
    transactionRef: {
        type: DataTypes.STRING(150),
        allowNull: false
    },
    accountId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        references: { model: 'ledger_accounts', key: 'id' }
    },
    direction: {
        type: DataTypes.ENUM('DEBIT', 'CREDIT'),
        allowNull: false
    },
    amountMinor: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'INR'
    },
    status: {
        type: DataTypes.ENUM('PENDING', 'POSTED', 'REVERSED', 'FAILED', 'HELD'),
        allowNull: false,
        defaultValue: 'POSTED'
    },
    // For a compensating entry, points at the entry it reverses.
    reversesEntryId: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    correlationId: {
        type: DataTypes.STRING(80),
        allowNull: true
    },
    memo: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    postedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    tableName: 'ledger_entries',
    timestamps: true,
    updatedAt: false,
    indexes: [
        { fields: ['journalId'] },
        { fields: ['transactionRef'] },
        { fields: ['accountId', 'createdAt'] },
        { fields: ['accountId', 'status'] },
        { fields: ['currency'] }
    ],
    hooks: {
        beforeUpdate: () => {
            throw new Error('Ledger entries are immutable: post a compensating journal instead of editing an entry.');
        },
        beforeDestroy: () => {
            throw new Error('Ledger entries are immutable: post a compensating journal instead of deleting an entry.');
        },
        beforeBulkUpdate: () => {
            throw new Error('Ledger entries are immutable: bulk updates are not permitted.');
        },
        beforeBulkDestroy: () => {
            throw new Error('Ledger entries are immutable: bulk deletes are not permitted.');
        }
    }
});

LedgerAccount.hasMany(LedgerEntry, { foreignKey: 'accountId', as: 'Entries' });
LedgerEntry.belongsTo(LedgerAccount, { foreignKey: 'accountId', as: 'Account' });

export default LedgerEntry;
