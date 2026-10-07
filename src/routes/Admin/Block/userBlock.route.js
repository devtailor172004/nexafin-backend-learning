import express from 'express';
import { updateUserBlockStatus } from '../../../controllers/Admin/Block/userBlock.controller.js'
import { verifyAdmin } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to block or unblock a user strictly by UUID
router.patch('/users/:uuid', verifyAdmin, updateUserBlockStatus);

export default router