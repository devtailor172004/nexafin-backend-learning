import './src/config/polyfill.js';
import dotenv from 'dotenv';
dotenv.config();

import { syncDatabase } from './src/config/syncDb.js';
import app from './src/app.js';
import logger from './src/utils/logger.js';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        // Sync database and run migrations
        await syncDatabase();

        app.listen(PORT, () => {
            const serverUrl = process.env.APP_URL || `http://localhost:${PORT}`;
            logger.info(`Server started and listening on ${serverUrl} & Auto Deploy on Server`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();
