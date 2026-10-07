import express from 'express';
import {
    createUser,
    getAllUsers,
    getUserById,
    updateUser,
    deleteUser,
    getCreatedUsers,
    getAllDetailsOfLoggedInUser
} from '../../controllers/Entities/entities.controller.js';
import { verifyToken, parseToken } from '../../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/register', parseToken, createUser);
router.get('/all', verifyToken, getAllUsers);
router.get('/created-users', verifyToken, getCreatedUsers);
router.get('/logged-in-user-details', verifyToken, getAllDetailsOfLoggedInUser);
router.get('/:uuid', verifyToken, getUserById);
router.put('/:uuid', verifyToken, updateUser);
router.delete('/:uuid', verifyToken, deleteUser);

export default router;