import express from 'express';
import { getActiveToken } from '../../../../controllers/Payment/PineLabs/Token/pineLabsToken.controller.js';
import { verifyToken } from '../../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to get or generate the cached Pine Labs access token (accepts credentials in request body)
router.post('/token', verifyToken, getActiveToken);

export default router;
