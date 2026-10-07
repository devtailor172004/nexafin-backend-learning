import express from 'express';
import { loginUser, getUserProfile, forgotPassword, logout } from '../../controllers/Auth/auth.controller.js';
import { verifyToken } from '../../middlewares/authMiddleware.js';
import { authLimiter, otpLimiter } from '../../middlewares/rateLimiter.js';

const router = express.Router();

router.post("/login", authLimiter, loginUser);
router.get("/profile", verifyToken, getUserProfile);
router.post("/forgot-password", otpLimiter, forgotPassword);
router.post("/logout", verifyToken, logout);

export default router;

