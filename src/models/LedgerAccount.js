import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from '../config/db.js';

/**
 * A ledger account.
 *
 * Balances are stored in **minor currency units** (paise for INR) as integers.
 * Floating point is never used for money anywhere in the ledger.
 *
 * `normalBalance` records which side increases the account:
 *   - DEBIT  increases ASSET / EXPENSE accounts (e.g. platform cash)
 *   - CREDIT increases LIABILITY / EQUITY / REVENUE accounts (e.g. a retailer wallet)
 *
 * `balanceMinor` is a cached projection of the posted entries. It is only ever
 * mutated inside a database transaction that holds a row lock, and the
 * authoritative value can always be recomputed from `LedgerEntry` rows.
 */
const LedgerAccount = sequelize.define('LedgerAccount', {
    id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true
    },
    code: {
        type: DataTypes.STRING(120),
        allowNull: false,
        unique: true
    },
    name: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    accountType: {
        type: DataTypes.ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'),
        allowNull: false,
        defaultValue: 'LIABILITY'
    },
    normalBalance: {
        type: DataTypes.ENUM('DEBIT', 'CREDIT'),
        allowNull: false,
        defaultValue: 'CREDIT'
    },
    currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'INR'
    },
    ownerType: {
        type: DataTypes.STRING(40),
        allowNull: true
    },
    ownerId: {
        type: DataTypes.STRING(80),
        allowNull: true
    },
    balanceMinor: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
    },
    // Portion of the balance currently reserved by open holds / freezes.
    holdMinor: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
    },
    isFrozen: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    isSystem: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    tableName: 'ledger_accounts',
    timestamps: true,
    indexes: [
        { fields: ['code'], unique: true },
        { fields: ['ownerType', 'ownerId'] },
        { fields: ['currency'] }
    ]
});

export default LedgerAccount;
