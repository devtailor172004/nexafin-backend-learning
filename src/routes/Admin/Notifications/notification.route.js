import express from 'express';
import {
    addNotification,
    getAllNotifications,
    getUserNotifications,
    getNotificationById,
    updateNotification,
    deleteNotification
} from '../../../controllers/Admin/Notifications/notification.controller.js';
import { verifyAdmin, verifyToken } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

// Admin routes
router.post('/add', verifyAdmin, addNotification);
router.get('/', verifyAdmin, getAllNotifications);
router.put('/:uuid', verifyAdmin, updateNotification);
router.delete('/:uuid', verifyAdmin, deleteNotification);

// User routes (Logged in users can get their notifications)
router.get('/user/my-notifications', verifyToken, getUserNotifications);
router.get('/:uuid', verifyToken, getNotificationById);

export default router;
