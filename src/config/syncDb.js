import pkg from 'sequelize';
const { DataTypes } = pkg;
import sequelize from './db.js';
import logger from '../utils/logger.js';

/**
 * CONFIG FLAGS
 * ----------------------------------------------------
 * ALLOW_ALTER_COLUMN : Alters column if data type or allowNull mismatch is detected
 * ----------------------------------------------------
 */
const ALLOW_ALTER_COLUMN = true;

/**
 * Compares existing MySQL table column definition with Sequelize Model attribute.
 * Returns true if a data type or nullability mismatch is detected.
 */
function isColumnMismatched(dbColumn, modelAttribute) {
    // --- Type check (loose comparison to handle DB dialect differences) ---
    const dbType = (dbColumn.type || '').toUpperCase();
    const modelType = getSequelizeTypeName(modelAttribute.type);

    const typeMismatch = modelType && !dbType.includes(modelType);

    // --- Nullable check ---
    const modelAllowNull = modelAttribute.allowNull !== false; // default true
    const nullMismatch = dbColumn.allowNull !== modelAllowNull;

    // --- ENUM value check ---
    // Sequelize sync detects type "ENUM" == "ENUM" and skips ALTER even when
    // the values list changed (e.g. a new member was added). We compare the
    // sorted value lists explicitly so that adding a new ENUM value
    // (e.g. NETBANKING) correctly triggers an ALTER TABLE.
    let enumMismatch = false;
    if (modelType === 'ENUM' && Array.isArray(modelAttribute.type?.values)) {
        // Normalize model ENUM values: uppercase + sorted
        const modelValues = [...modelAttribute.type.values]
            .map(v => v.toUpperCase())
            .sort();

        // MySQL returns: ENUM('CARD','UPI') — parse it
        // Handle both single-quoted and unquoted formats defensively
        const dbEnumMatch = dbType.match(/^ENUM\((.+)\)$/);
        if (dbEnumMatch) {
            const dbValues = dbEnumMatch[1]
                .split(',')
                .map(v => v.replace(/['"]/g, '').trim().toUpperCase())
                .sort();

            enumMismatch = JSON.stringify(modelValues) !== JSON.stringify(dbValues);
        }
        // If DB type doesn't look like ENUM(...) at all — something is wrong,
        // but we already handle it via typeMismatch above. Don't force ALTER.
    }

    return typeMismatch || nullMismatch || enumMismatch;
}


/**
 * Maps Sequelize DataType object keys to comparable MySQL database base types.
 */
function getSequelizeTypeName(type) {
    if (!type) return null;
    const key = type.key || type.constructor?.key;

    const map = {
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
        UUID: 'CHAR',
    };

    return map[key] || null;
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

    try {
        logger.info('Starting database auto-synchronization...');


        // 1. Create missing tables (does not alter existing tables)
        await sequelize.sync();


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
                            const rows = await sequelize.query(`SELECT id FROM \`${tableName}\` WHERE \`uuid\` IS NULL`, { type: sequelize.QueryTypes.SELECT });
                            for (const row of rows) {
                                const newUuid = crypto.randomUUID();
                                await sequelize.query(`UPDATE \`${tableName}\` SET \`uuid\` = '${newUuid}' WHERE \`id\` = ${row.id}`);
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
                if (ALLOW_ALTER_COLUMN) {
                    // Skip primary key and auto-increment columns (primary keys cannot be re-altered in MySQL)
                    if (attribute.primaryKey || attribute.autoIncrement) {
                        continue;
                    }

                    const needsAlter = isColumnMismatched(existingColumn, attribute);

                    if (needsAlter) {
                        logger.info(`[Auto-Sync] Altering column '${columnName}' on '${tableName}' (type/allowNull changed)...`);
                        try {
                            await queryInterface.changeColumn(tableName, columnName, attribute);
                        } catch (err) {
                            logger.error(`[Auto-Sync] Failed to alter column '${columnName}' on '${tableName}':`, err.message);
                        }
                    }
                }
            }
        }

        logger.info('Sequelize database sync completed successfully!');
    } catch (error) {
        logger.error('Error during database synchronization:', error);
    }
};
