import '../src/config/polyfill.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Database bootstrap for the hosted (Postgres/Neon) database.
 *
 *   node scripts/dbSetup.js            # create missing tables + indexes
 *   node scripts/dbSetup.js --seed     # ...and ensure the dev admin exists
 *
 * Reads the same env as the app (DATABASE_URL or DB_*). Registering `src/app.js`
 * imports every model + association, so `syncDatabase()` sees the full schema.
 */

const { syncDatabase } = await import('../src/config/syncDb.js');
const { default: sequelize } = await import('../src/config/db.js');
await import('../src/app.js');
const { default: User } = await import('../src/models/User.js');

const seed = process.argv.includes('--seed');

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@securepay.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
const ADMIN_MOBILE = process.env.SEED_ADMIN_MOBILE || '9000000000';

const main = async () => {
    console.log(`Dialect: ${sequelize.getDialect()}`);
    await sequelize.authenticate();
    console.log('Connection OK.');

    await syncDatabase();

    const isPostgres = sequelize.getDialect() === 'postgres';
    const [tables] = isPostgres
        ? await sequelize.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
        : await sequelize.query('SHOW TABLES');

    const names = tables.map((row) => row.name || Object.values(row)[0]);
    console.log(`Tables (${names.length}): ${names.join(', ')}`);

    if (seed) {
        const existing = await User.findOne({ where: { email: ADMIN_EMAIL } });
        if (existing) {
            console.log(`Admin already exists: ${ADMIN_EMAIL} (id=${existing.id})`);
        } else {
            const admin = await User.create({
                fullName: 'SecurePay Admin',
                email: ADMIN_EMAIL,
                mobile: ADMIN_MOBILE,
                password: ADMIN_PASSWORD,
                role: 'Admin',
                kyc: 'Approved'
            });
            console.log(`Created admin ${admin.email} (id=${admin.id}, role=${admin.role})`);
        }
    }

    await sequelize.close();
    console.log('Done.');
};

main().catch(async (error) => {
    console.error('dbSetup failed:', error);
    try { await sequelize.close(); } catch { /* ignore */ }
    process.exit(1);
});
