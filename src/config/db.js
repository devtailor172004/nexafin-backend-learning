import pkg from 'sequelize';
const { Sequelize } = pkg;
import dotenv from 'dotenv';
dotenv.config();
import logger from '../utils/logger.js';

const sequelize = new Sequelize(process.env.DB_DATABASE, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    dialect: process.env.DB_DIALECT,
    logging: false,
    pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 5,     // Shared hosting: 5, VPS: 25
        min: parseInt(process.env.DB_POOL_MIN) || 0,     // 0 = connections close when idle
        acquire: 30000,
        idle: 10000
    }
});

sequelize.authenticate()
    .then(() => {
        logger.info('SQL Database (Sequelize) successfully connected!');
    })
    .catch((err) => {
        logger.error('Database connection failed:', err);
    });

export default sequelize;