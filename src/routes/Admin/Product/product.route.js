
import express from 'express';
import { getUserProducts, getLoggedInUserProducts, updateUserProducts, addMasterProduct, getAllMasterProducts, updateMasterProductStatus, requestProductActivation, getPendingProducts } from '../../../controllers/Admin/Product/product.controller.js'
import { verifyAdmin, verifyToken } from '../../../middlewares/authMiddleware.js';

const router = express.Router();

// Route to get list of all pending product activation requests (Admin only)
router.get('/pending', verifyAdmin, getPendingProducts);

// Route to request product activation (User route)
router.put('/request-activation', verifyToken, requestProductActivation);

// Route to get product status list for logged-in user
router.get('/my-products', verifyToken, getLoggedInUserProducts);

// Route to get product status list for a specific user (Admin)
router.get('/users/:uuid', verifyAdmin, getUserProducts);

// Route to update product status for a user
router.put('/users/:uuid', verifyAdmin, updateUserProducts);

// Route to add a new product type (Admin only)
router.post('/add', verifyAdmin, addMasterProduct);

// Route to get list of all product types (Admin only)
router.get('/master-product', verifyAdmin, getAllMasterProducts);

// Route to update status of a master product (Admin only)
router.put('/master-product/:uuid/status', verifyAdmin, updateMasterProductStatus);

export default router;