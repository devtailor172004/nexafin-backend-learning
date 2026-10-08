import pkg from 'sequelize';
const { Sequelize } = pkg;
import dotenv from 'dotenv';
dotenv.config();
import logger from '../utils/logger.js';

/**
 * Database connection.
 *
 * Two supported configurations:
 *
 *   1. Managed Postgres (Neon / Supabase / Tiger Cloud) — set DATABASE_URL to a
 *      `postgres://...` connection string. This is the Phase 3 "real data"
 *      target. `pg` + `pg-hstore` provide the driver.
 *
 *   2. Self-managed MySQL — the original setup: DB_DATABASE / DB_USER /
 *      DB_PASSWORD / DB_HOST / DB_DIALECT.
 *
 * The dialect is inferred from DATABASE_URL when present, and can always be
 * forced with DB_DIALECT (e.g. DB_DIALECT=postgres).
 */

const databaseUrl = process.env.DATABASE_URL?.trim();

// When DATABASE_URL is present its scheme is authoritative — otherwise a stale
// `DB_DIALECT=mysql` left in .env would try to speak MySQL to a Postgres URL.
const urlDialect = databaseUrl?.startsWith('postgres') ? 'postgres'
    : databaseUrl?.startsWith('mysql') ? 'mysql'
    : null;

const dialect = (
    urlDialect || process.env.DB_DIALECT || 'mysql'
).toLowerCase();

const isPostgres = dialect === 'postgres' || dialect === 'postgresql';

const commonOptions = {
    dialect: isPostgres ? 'postgres' : dialect,
    logging: false,
    pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 5,     // Shared hosting: 5, VPS: 25
        min: parseInt(process.env.DB_POOL_MIN) || 0,     // 0 = connections close when idle
        acquire: 30000,
        idle: 10000
    }
};

if (isPostgres) {
    // Neon (and most managed Postgres) requires TLS. Managed providers present
    // their own CA, so verification is relaxed by default; set DB_SSL_STRICT=true
    // to enforce full certificate validation, or DB_SSL=false to disable TLS.
    if (process.env.DB_SSL !== 'false') {
        commonOptions.dialectOptions = {
            ssl: {
                require: true,
                rejectUnauthorized: process.env.DB_SSL_STRICT === 'true'
            }
        };
    }
}

const sequelize = databaseUrl
    ? new Sequelize(databaseUrl, commonOptions)
    : new Sequelize(process.env.DB_DATABASE, process.env.DB_USER, process.env.DB_PASSWORD, {
        ...commonOptions,
        host: process.env.DB_HOST
    });

sequelize.authenticate()
    .then(() => {
        logger.info(`SQL Database (Sequelize/${sequelize.getDialect()}) successfully connected!`);
    })
    .catch((err) => {
        logger.error('Database connection failed:', err);
    });

export { isPostgres };
export default sequelize;
