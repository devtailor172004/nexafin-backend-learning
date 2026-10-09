import dotenv from 'dotenv';
dotenv.config();

import sequelize from '../src/config/db.js';
import User from '../src/models/User.js';

/**
 * Clears the login lockout for the seeded admin (or an email given as an
 * argument) so a local demo can never be blocked by the brute-force protection.
 *
 *   npm run auth:unlock                     # unlocks SEED_ADMIN_EMAIL
 *   npm run auth:unlock -- someone@x.local  # unlocks a specific account
 *
 * This only resets the lockout counters. It never prints or changes passwords.
 */
const email = (process.argv[2] || process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();

if (!email) {
    console.error('No email supplied and SEED_ADMIN_EMAIL is not set.');
    process.exit(1);
}

const run = async () => {
    await sequelize.authenticate();

    const user = await User.findOne({ where: { email } });
    if (!user) {
        console.error(`No account found for ${email}`);
        process.exit(1);
    }

    user.failed_login_attempts = 0;
    user.locked_until = null;
    await user.save();

    console.log(`Unlocked ${user.email} (id=${user.id}, role=${user.role}).`);
    console.log('failed_login_attempts=0, locked_until=null');
    process.exit(0);
};

run().catch((error) => {
    console.error('Unlock failed:', error.message);
    process.exit(1);
});
