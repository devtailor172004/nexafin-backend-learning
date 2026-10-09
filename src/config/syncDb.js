import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from './db.js';
import logger from '../utils/logger.js';

/**
 * CONFIG FLAGS
 * ----------------------------------------------------
 * ALLOW_ALTER_COLUMN : Alters a column when a data type or allowNull mismatch
 *                      is detected. This is safe on MySQL (the original
 *                      deployment) but is intentionally NOT applied on
 *                      Postgres, where a plain type change (e.g. JSON -> UUID)
 *                      requires a `USING` cast and would otherwise fail or
 *                      destroy data. On Postgres, mismatches are logged as
 *                      warnings instead. A fresh Neon database needs no ALTERs
 *                      at all.
 * ----------------------------------------------------
 */
const ALLOW_ALTER_COLUMN = true;

/**
 * Maps Sequelize DataTypes to comparable database base types, per dialect.
 * `describeTable()` reports vendor specific names, so the same Sequelize type
 * is compared against a different string on each engine.
 */
const TYPE_MAP = {
    mysql: {
        STRING: 'VARCHAR',
        TEXT: 'TEXT',
        INTEGER: 'INT',
        BIGINT: 'BIGINT',
        FLOAT: 'FLOAT',
        DOUBLE: 'DOUBLE',
        DECIMAL: 'DECIMAL',
        BOOLEAN: 'TINYINT', // In MySQL, BOOLEAN is represented as TINYINT(1)
        DATE: 'DATETIME',
        DATEONLY: 'DATE',
        ENUM: 'ENUM',
        JSON: 'JSON',
        UUID: 'CHAR'
    },
    postgres: {
        STRING: 'CHARACTER VARYING',
        TEXT: 'TEXT',
        INTEGER: 'INTEGER',
        BIGINT: 'BIGINT',
        FLOAT: 'REAL',
        DOUBLE: 'DOUBLE PRECISION',
        DECIMAL: 'NUMERIC',
        BOOLEAN: 'BOOLEAN',
        DATE: 'TIMESTAMP',
        DATEONLY: 'DATE',
        ENUM: 'USER-DEFINED',
        JSON: 'JSON',
        UUID: 'UUID'
    }
};

const getSequelizeTypeName = (type, dialect) => {
    if (!type) return null;
    const key = type.key || type.constructor?.key;
    const map = TYPE_MAP[dialect] || TYPE_MAP.mysql;
    return map[key] || null;
};

/**
 * Compares an existing table column definition with a Sequelize Model
 * attribute. Returns true if a data type or nullability mismatch is detected.
 *
 * ENUM value lists are handled separately (see syncEnumValues) because the
 * engines expose them completely differently.
 */
function isColumnMismatched(dbColumn, modelAttribute, dialect) {
    const modelType = getSequelizeTypeName(modelAttribute.type, dialect);

    // Native Postgres enums report as USER-DEFINED; their values are synced
    // separately and never via changeColumn.
    if (modelType === 'USER-DEFINED') return false;

    // --- Type check (loose comparison to handle DB dialect differences) ---
    const dbType = (dbColumn.type || '').toUpperCase();
    const typeMismatch = modelType && !dbType.includes(modelType);

    // --- Nullable check ---
    const modelAllowNull = modelAttribute.allowNull !== false; // default true
    const nullMismatch = dbColumn.allowNull !== modelAllowNull;

    // --- ENUM value check (MySQL only) ---
    // Sequelize sync detects type "ENUM" == "ENUM" and skips ALTER even when
    // the values list changed (e.g. a new member was added). We compare the
    // sorted value lists explicitly so that adding a new ENUM value
    // (e.g. NETBANKING) correctly triggers an ALTER TABLE.
    let enumMismatch = false;
    if (dialect === 'mysql' && modelType === 'ENUM' && Array.isArray(modelAttribute.type?.values)) {
        const modelValues = [...modelAttribute.type.values]
            .map(v => v.toUpperCase())
            .sort();

        // MySQL returns: ENUM('CARD','UPI') — parse it
        const dbEnumMatch = dbType.match(/^ENUM\((.+)\)$/);
        if (dbEnumMatch) {
            const dbValues = dbEnumMatch[1]
                .split(',')
                .map(v => v.replace(/['"]/g, '').trim().toUpperCase())
                .sort();

            enumMismatch = JSON.stringify(modelValues) !== JSON.stringify(dbValues);
        }
    }

    return typeMismatch || nullMismatch || enumMismatch;
}

/**
 * Adds any query-defined ENUM values that are missing from the native Postgres
 * enum type. `sequelize.sync()` only creates the type; it never grows it, so a
 * newly added status (e.g. a new payment state) would otherwise be rejected.
 */
async function syncPostgresEnumValues(tableName, modelAttributes) {
    for (const attrName of Object.keys(modelAttributes)) {
        const attribute = modelAttributes[attrName];
        if (!attribute.type || attribute.type.key !== 'ENUM') continue;
        if (!Array.isArray(attribute.type.values)) continue;

        const columnName = attribute.field || attrName;
        // Sequelize's native Postgres enum naming convention.
        const enumTypeName = `enum_${tableName}_${columnName}`;

        let rows;
        try {
            rows = await sequelize.query(
                `SELECT e.enumlabel AS label
                   FROM pg_enum e
                   JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = :typeName`,
                {
                    replacements: { typeName: enumTypeName },
                    type: sequelize.QueryTypes.SELECT
                }
            );
        } catch (err) {
            logger.warn(`[Auto-Sync] Could not inspect enum ${enumTypeName}: ${err.message}`);
            continue;
        }

        // Type does not exist yet (sync() will create it on a fresh database).
        if (!rows || rows.length === 0) continue;

        const existing = rows.map(r => String(r.label));
        for (const value of attribute.type.values) {
            if (existing.includes(String(value))) continue;

            logger.info(`[Auto-Sync] Adding missing ENUM value '${value}' to ${enumTypeName}...`);
            try {
                const escaped = String(value).replace(/'/g, "''");
                // ADD VALUE IF NOT EXISTS keeps this idempotent. Postgres 12+
                // permits this outside an explicit transaction (Neon is PG16).
                await sequelize.query(`ALTER TYPE "${enumTypeName}" ADD VALUE IF NOT EXISTS '${escaped}'`);
            } catch (err) {
                logger.error(`[Auto-Sync] Failed to add ENUM value '${value}' to ${enumTypeName}: ${err.message}`);
            }
        }
    }
}

export const syncDatabase = async () => {
    const isProduction = process.env.NODE_ENV === 'production';
    const autoSyncEnv = process.env.DB_AUTO_SYNC;

    // 1. Explicitly disabled via environment variable (e.g. DB_AUTO_SYNC=false)
    if (autoSyncEnv === 'false') {
        logger.info('[Database Safety] Automatic database schema sync is explicitly DISABLED via DB_AUTO_SYNC=false.');
        return;
    }

    // 2. Production safety guard: disabled in production unless explicitly set to DB_AUTO_SYNC=true
    if (isProduction && autoSyncEnv !== 'true') {
        logger.warn('[Database Safety] Production mode detected. Automatic database schema sync (sequelize.sync()) is DISABLED for data safety and compliance.');
        logger.warn('[Database Safety] To apply database schema changes in production, use version-controlled SQL migrations or set DB_AUTO_SYNC=true to override.');
        return;
    }

    const dialect = sequelize.getDialect();
    const isPostgres = dialect === 'postgres';

    try {
        logger.info(`Starting database auto-synchronization (${dialect})...`);

        // 1. Create missing tables (does not alter existing tables).
        //
        // Sync each model on its own rather than calling sequelize.sync() once.
        // A single failure used to abort the whole routine, so a database that
        // predates a new column ended up half-migrated: Sequelize builds a
        // model's indexes as part of sync(), and an index over a column the
        // older table does not have yet throws (the audit chain's `sequence`
        // index did exactly this). Containing the failure lets the column
        // backfill below run, after which the failed models are re-synced.
        const deferredSyncs = [];
        for (const modelName of Object.keys(sequelize.models)) {
            try {
                await sequelize.models[modelName].sync();
            } catch (err) {
                deferredSyncs.push(modelName);
                logger.warn(
                    `[Auto-Sync] Initial sync for '${modelName}' deferred until missing columns are added: ${err.message}`
                );
            }
        }

        const queryInterface = sequelize.getQueryInterface();
        const models = sequelize.models;

        for (const modelName of Object.keys(models)) {
            const model = models[modelName];
            const tableName = model.tableName;

            let tableDefinition;
            try {
                tableDefinition = await queryInterface.describeTable(tableName);
            } catch (err) {
                logger.warn(`[Auto-Sync] Table '${tableName}' description failed, skipping. (${err.message})`);
                continue;
            }

            const modelAttributes = model.rawAttributes;

            // ---- 2. Add missing columns & check existing columns for type/allowNull mismatches ----
            for (const attrName of Object.keys(modelAttributes)) {
                const attribute = modelAttributes[attrName];

                // Skip VIRTUAL fields (memory-only getters/setters, not DB columns)
                if (attribute.type instanceof DataTypes.VIRTUAL || attribute.type?.key === 'VIRTUAL') {
                    continue;
                }

                const columnName = attribute.field || attrName;
                const existingColumn = tableDefinition[columnName];

                if (!existingColumn) {
                    // Column does not exist in DB -> ADD column
                    logger.info(`[Auto-Sync] Adding missing column '${columnName}' to '${tableName}'...`);

                    const columnDef = { ...attribute };

                    // If adding a unique/NOT NULL column to an existing populated table, add as nullable first without unique constraint
                    if (columnDef.unique) delete columnDef.unique;
                    if (columnDef.allowNull === false) {
                        columnDef.allowNull = true;
                    }

                    try {
                        await queryInterface.addColumn(tableName, columnName, columnDef);

                        // If column is 'uuid', populate unique UUIDv4 values for existing rows and add unique index
                        if (columnName === 'uuid') {
                            const crypto = await import('crypto');
                            const quotedTable = queryInterface.quoteIdentifier(tableName);
                            const quotedUuid = queryInterface.quoteIdentifier('uuid');
                            const quotedId = queryInterface.quoteIdentifier('id');

                            const rows = await sequelize.query(
                                `SELECT ${quotedId} AS id FROM ${quotedTable} WHERE ${quotedUuid} IS NULL`,
                                { type: sequelize.QueryTypes.SELECT }
                            );
                            for (const row of rows) {
                                const newUuid = crypto.randomUUID();
                                await sequelize.query(
                                    `UPDATE ${quotedTable} SET ${quotedUuid} = :newUuid WHERE ${quotedId} = :id`,
                                    { replacements: { newUuid, id: row.id } }
                                );
                            }
                            try {
                                await queryInterface.addIndex(tableName, ['uuid'], { unique: true, name: `${tableName}_uuid_unique` });
                            } catch (idxErr) {
                                // Index might already exist, ignore error
                            }
                        }
                    } catch (err) {
                        logger.error(`[Auto-Sync] Failed to add column '${columnName}' on '${tableName}':`, err.message);
                    }

                    continue;
                }

                // ---- 3. Column already exists -> Check for TYPE / NULLABILITY mismatches ----
                if (!ALLOW_ALTER_COLUMN) continue;

                // Skip primary key and auto-increment columns (primary keys cannot be re-altered)
                if (attribute.primaryKey || attribute.autoIncrement) {
                    continue;
                }

                const needsAlter = isColumnMismatched(existingColumn, attribute, dialect);

                if (needsAlter) {
                    if (isPostgres) {
                        // Postgres type changes need an explicit USING cast and can
                        // be destructive; surface the mismatch instead of guessing.
                        logger.warn(`[Auto-Sync] Column mismatch on '${tableName}.${columnName}' (${existingColumn.type} -> ${getSequelizeTypeName(attribute.type, dialect)}). Skipped on Postgres — apply via a migration.`);
                        continue;
                    }
                    logger.info(`[Auto-Sync] Altering column '${columnName}' on '${tableName}' (type/allowNull changed)...`);
                    try {
                        await queryInterface.changeColumn(tableName, columnName, attribute);
                    } catch (err) {
                        logger.error(`[Auto-Sync] Failed to alter column '${columnName}' on '${tableName}':`, err.message);
                    }
                }
            }

            // ---- 4. Grow native Postgres ENUM types with newly added values ----
            if (isPostgres) {
                await syncPostgresEnumValues(tableName, modelAttributes);
            }
        }

        // ---- 5. Retry the models whose first sync was deferred ----
        // Their indexes could only be created once the missing columns above
        // existed, so this second pass is what actually completes the schema.
        for (const modelName of deferredSyncs) {
            try {
                await models[modelName].sync();
                logger.info(`[Auto-Sync] Re-synced '${modelName}' after adding its missing columns.`);
            } catch (err) {
                logger.error(`[Auto-Sync] Re-sync for '${modelName}' still failed: ${err.message}`);
            }
        }

        logger.info('Sequelize database sync completed successfully!');
    } catch (error) {
        logger.error('Error during database synchronization:', error);
    }
};
