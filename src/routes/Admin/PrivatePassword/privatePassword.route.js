import express from 'express';
import { updatePrivatePassword } from '../../../controllers/Admin/PrivatePassword/privatePassword.controller.js';
import { verifyAdmin } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to set or update the admin KYC private password
router.put('/', verifyAdmin, updatePrivatePassword);

export default router;
