import pkg from 'sequelize';
const { Op } = pkg;
import sequelize from '../../../config/db.js';
import MasterProduct from '../../../models/MasterProduct.js';
import Product from '../../../models/Product.js';
import ProductToken from '../../../models/ProductToken.js';
import User from '../../../models/User.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';

// Helper function to get or create products with default 'deactive' status for a user
export const getOrCreateUserProducts = async (userId, outerTransaction = null) => {
    const executeQueries = async (t) => {
        // Fetch products dynamically from master products table
        const masterProducts = await MasterProduct.findAll({ transaction: t });
        const requiredProducts = masterProducts.map(p => p.name);

        let products = await Product.findAll({
            where: { userId },
            order: [['product_name', 'ASC']],
            transaction: t
        });

        const existingNames = products.map(p => p.product_name);
        const missing = requiredProducts.filter(p => !existingNames.includes(p));

        if (missing.length > 0) {
            const toCreate = missing.map(prod => ({
                userId,
                product_name: prod,
                status: 'deactive'
            }));
            await Product.bulkCreate(toCreate, { ignoreDuplicates: true, transaction: t });

            products = await Product.findAll({
                where: { userId },
                order: [['product_name', 'ASC']],
                transaction: t
            });
        }

        return products;
    };

    if (outerTransaction) {
        return await executeQueries(outerTransaction);
    } else {
        return await sequelize.transaction(async (t) => {
            return await executeQueries(t);
        });
    }
};

/**
 * @desc    Fetch product statuses of a user strictly by UUID (Admin)
 * @route   GET /api/admin/products/users/:uuid
 * @access  Private (Admin)
 */
export const getUserProducts = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { status } = req.query; // E.g. ?status=active or ?status=deactive

    const user = await User.findOne({ where: { uuid } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    // Ensure products exist in DB
    await getOrCreateUserProducts(user.id);

    const whereClause = { userId: user.id };
    if (status && ['active', 'deactive'].includes(String(status).trim().toLowerCase())) {
        whereClause.status = String(status).trim().toLowerCase();
    }

    const products = await Product.findAll({
        where: whereClause,
        order: [['product_name', 'ASC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, products, "User products fetched successfully.")
    );
});

/**
 * @desc    Fetch product statuses for logged-in user
 * @route   GET /api/admin/products/my-products
 * @access  Private (User)
 */
export const getLoggedInUserProducts = asyncHandler(async (req, res) => {
    const { status } = req.query; // E.g. ?status=active or ?status=deactive or ?status=pending

    const user = await getAuthenticatedUser(req);

    // Ensure products exist in DB
    await getOrCreateUserProducts(user.id);

    const whereClause = { userId: user.id };
    if (status && ['active', 'deactive', 'pending'].includes(String(status).trim().toLowerCase())) {
        whereClause.status = String(status).trim().toLowerCase();
    }

    const products = await Product.findAll({
        where: whereClause,
        order: [['product_name', 'ASC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, products, "My products fetched successfully.")
    );
});

/**
 * @desc    Update status of a specific product for a user strictly by UUID (Admin)
 * @route   PUT /api/admin/products/users/:uuid
 * @access  Private (Admin)
 */
export const updateUserProducts = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { product_name, status } = req.body;

    const formattedProductName = String(product_name || '').trim().toUpperCase();
    const masterProductExists = await MasterProduct.findOne({ where: { name: formattedProductName } });
    if (!masterProductExists) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid product_name. Product '${product_name}' does not exist.`);
    }

    if (!status || !['active', 'deactive', 'pending'].includes(status)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid status. Must be one of: active, deactive, pending");
    }

    if (status === 'active' && masterProductExists.status === 'deactive') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Cannot activate product '${product_name}' because it has been deactivated by the admin at the master level.`);
    }

    const user = await User.findOne({ where: { uuid } });
    if (!user) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found!");
    }

    // Wrap multi-step operations (Token generation, Product provisioning, Status update) inside a Managed Transaction
    const { updatedProduct, clientCredentials } = await sequelize.transaction(async (t) => {
        // Ensure products exist in DB with transaction lock
        await getOrCreateUserProducts(user.id, t);

        // Update product status
        await Product.update(
            { status },
            { where: { userId: user.id, product_name: formattedProductName }, transaction: t }
        );

        // Count how many products are active for this user
        const activeCount = await Product.count({
            where: { userId: user.id, status: 'active' },
            transaction: t
        });

        let credentials = null;

        if (activeCount > 0) {
            // Retrieve or generate credentials
            let tokenRecord = await ProductToken.findOne({ where: { userId: user.id }, transaction: t });
            
            if (!tokenRecord || !tokenRecord.clientId || !tokenRecord.clientSecret) {
                const crypto = await import('crypto');
                const clientId = 'cid_' + crypto.randomBytes(16).toString('hex');
                const clientSecret = 'csec_' + crypto.randomBytes(32).toString('hex');

                if (!tokenRecord) {
                    try {
                        tokenRecord = await ProductToken.create({
                            userId: user.id,
                            clientId,
                            clientSecret
                        }, { transaction: t });
                    } catch (err) {
                        if (err.name === 'SequelizeUniqueConstraintError') {
                            tokenRecord = await ProductToken.findOne({ where: { userId: user.id }, transaction: t });
                            // If it still doesn't have it, update it
                            if (!tokenRecord.clientId || !tokenRecord.clientSecret) {
                                tokenRecord.clientId = clientId;
                                tokenRecord.clientSecret = clientSecret;
                                await tokenRecord.save({ transaction: t });
                            }
                        } else {
                            throw err;
                        }
                    }
                } else {
                    tokenRecord.clientId = clientId;
                    tokenRecord.clientSecret = clientSecret;
                    await tokenRecord.save({ transaction: t });
                }
            }

            credentials = {
                clientId: tokenRecord.clientId,
                clientSecret: tokenRecord.clientSecret
            };
        } else {
            // No active products -> nullify credentials
            await ProductToken.update(
                { clientId: null, clientSecret: null },
                { where: { userId: user.id }, transaction: t }
            );
        }

        const prod = await Product.findOne({
            where: { userId: user.id, product_name: formattedProductName },
            transaction: t
        });

        return { updatedProduct: prod, clientCredentials: credentials };
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            product: updatedProduct,
            clientCredentials
        }, `Product '${formattedProductName}' status successfully updated to '${status}'.`)
    );
});

/**
 * @desc    Add a new master product type (Admin)
 * @route   POST /api/admin/products/add
 * @access  Private (Admin)
 */
export const addMasterProduct = asyncHandler(async (req, res) => {
    const { name, display_name, status } = req.body;

    if (!name || String(name).trim() === '') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Product name is required.");
    }

    const formattedName = String(name).trim().toUpperCase();

    // Check if already exists
    const existing = await MasterProduct.findOne({ where: { name: formattedName } });
    if (existing) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Product '${formattedName}' already exists.`);
    }

    const finalStatus = status ? String(status).trim().toLowerCase() : 'active';
    if (!['active', 'deactive'].includes(finalStatus)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid status. Must be one of: active, deactive");
    }

    // Execute master creation + user mapping in an atomic transaction
    const newProduct = await sequelize.transaction(async (t) => {
        const createdMaster = await MasterProduct.create({
            name: formattedName,
            display_name: display_name ? String(display_name).trim() : formattedName,
            status: finalStatus
        }, { transaction: t });

        // Populate this product for all existing users with 'deactive' status
        const users = await User.findAll({ attributes: ['id'], transaction: t });
        if (users.length > 0) {
            const userProducts = users.map(user => ({
                userId: user.id,
                product_name: formattedName,
                status: 'deactive'
            }));
            await Product.bulkCreate(userProducts, { ignoreDuplicates: true, transaction: t });
        }

        return createdMaster;
    });

    return res.status(HTTP_STATUS.CREATED).json(
        new ApiResponse(HTTP_STATUS.CREATED, newProduct, `Product '${formattedName}' successfully created and added to all users.`)
    );
});

/**
 * @desc    Update status of a master product strictly by UUID (Admin)
 * @route   PUT /api/admin/products/master-product/:uuid/status
 * @access  Private (Admin)
 */
export const updateMasterProductStatus = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { status } = req.body;

    if (!status || !['active', 'deactive'].includes(status)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Invalid status. Must be one of: active, deactive");
    }

    const masterProduct = await MasterProduct.findOne({ where: { uuid } });
    if (!masterProduct) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Master product not found!");
    }

    await sequelize.transaction(async (t) => {
        masterProduct.status = status;
        await masterProduct.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, masterProduct, `Master product '${masterProduct.name}' status successfully updated to '${status}'.`)
    );
});

/**
 * @desc    Get all product types (Admin)
 * @route   GET /api/admin/products/master-product
 * @access  Private (Admin)
 */
export const getAllMasterProducts = asyncHandler(async (req, res) => {
    const products = await MasterProduct.findAll({
        order: [['createdAt', 'ASC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, products, "Master products list fetched successfully.")
    );
});

/**
 * @desc    Request product activation (User)
 * @route   PUT /api/admin/products/request-activation
 * @access  Private (User)
 */
export const requestProductActivation = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { product_name } = req.body;

    if (!product_name || String(product_name).trim() === '') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Product name is required.");
    }

    const formattedProductName = String(product_name).trim().toUpperCase();
    const masterProduct = await MasterProduct.findOne({ where: { name: formattedProductName } });
    if (!masterProduct) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Invalid product_name. Product '${product_name}' does not exist.`);
    }

    if (masterProduct.status === 'deactive') {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Cannot request activation for product '${product_name}' because it has been deactivated by the admin at the master level.`);
    }

    const updatedUserProduct = await sequelize.transaction(async (t) => {
        // Ensure user products exist in DB with transaction lock
        await getOrCreateUserProducts(userId, t);

        // Find current user product
        const userProduct = await Product.findOne({
            where: { userId, product_name: formattedProductName },
            transaction: t
        });

        if (userProduct.status === 'active') {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Product '${formattedProductName}' is already active.`);
        }

        if (userProduct.status === 'pending') {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `Activation request for product '${formattedProductName}' is already pending.`);
        }

        // Set status to pending
        userProduct.status = 'pending';
        await userProduct.save({ transaction: t });

        return userProduct;
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, updatedUserProduct, `Activation request for product '${formattedProductName}' is submitted and is now pending admin approval.`)
    );
});

/**
 * @desc    Get all pending product activation requests (Admin)
 * @route   GET /api/admin/products/pending
 * @access  Private (Admin)
 */
export const getPendingProducts = asyncHandler(async (req, res) => {
    const { product_name, fullName, mobile } = req.query;

    const productWhere = { status: 'pending' };

    if (product_name) {
        productWhere.product_name = { [Op.like]: `%${String(product_name).trim()}%` };
    }

    const userWhere = {};

    if (fullName) {
        userWhere.fullName = { [Op.like]: `%${String(fullName).trim()}%` };
    }

    if (mobile) {
        userWhere.mobile = { [Op.like]: `%${String(mobile).trim()}%` };
    }

    const userInclude = {
        model: User,
        as: 'User',
        attributes: ['id', 'uuid', 'fullName', 'email', 'mobile']
    };

    if (Object.keys(userWhere).length > 0) {
        userInclude.where = userWhere;
    }

    const pendingProducts = await Product.findAll({
        where: productWhere,
        include: [userInclude],
        order: [['updatedAt', 'DESC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, pendingProducts, "Pending product activation requests fetched successfully.")
    );
});
