import express from 'express';
import { getAllUserIps, updateUserIpStatus, ipAddressCheck } from '../../../controllers/Admin/IP/ip.controller.js';
import { verifyAdmin, verifyToken } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

// User route to submit IP for verification (Users only, requires only token)
router.post('/ip-check', verifyToken, ipAddressCheck);

// Admin routes (Admin privileges required)
router.get('/', verifyAdmin, getAllUserIps);
router.put('/:uuid/status', verifyAdmin, updateUserIpStatus);

export default router;
