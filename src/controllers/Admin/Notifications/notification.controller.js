import pkg from 'sequelize';
const { Op } = pkg;
import sequelize from '../../../config/db.js';
import Notification from '../../../models/Notifications.js';
import User from '../../../models/User.js';
import Product from '../../../models/Product.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getPaginationParams, formatPaginatedResponse } from '../../../utils/paginationHelper.js';

/**
 * @desc    Add a new notification (Admin)
 * @route   POST /api/admin/notifications/add
 * @access  Private (Admin)
 */
export const addNotification = asyncHandler(async (req, res) => {
    const { title, message, type = 'info', send_to = 'all', userId, product_name } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Notification title is required.");
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Notification message is required.");
    }

    let targetUserId = null;
    let targetProductName = null;

    if (send_to === 'specific') {
        if (!userId) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "userId is required when send_to is 'specific'.");
        }

        const targetUser = await User.findOne({
            where: isNaN(userId) ? { uuid: userId } : { [Op.or]: [{ uuid: userId }, { id: userId }] }
        });
        if (!targetUser) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, `Target user not found.`);
        }
        targetUserId = targetUser.id;
    } else if (send_to === 'product') {
        if (!product_name || typeof product_name !== 'string' || !product_name.trim()) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "product_name is required when send_to is 'product'.");
        }
        targetProductName = product_name.trim();
    }

    const notification = await Notification.create({
        title: title.trim(),
        message: message.trim(),
        type,
        send_to,
        userId: targetUserId,
        product_name: targetProductName,
        created_by: req.user?.id || null,
        status: 'active'
    });

    let successMsg = "Notification added successfully and broadcast to all users.";
    if (send_to === 'specific') {
        successMsg = `Notification added successfully for target user.`;
    } else if (send_to === 'product') {
        successMsg = `Notification added successfully for product '${targetProductName}'.`;
    }

    return res.status(HTTP_STATUS.CREATED).json(
        new ApiResponse(
            HTTP_STATUS.CREATED,
            notification,
            successMsg
        )
    );
});

/**
 * @desc    Get all notifications (Admin View)
 * @route   GET /api/admin/notifications
 * @access  Private (Admin)
 */
export const getAllNotifications = asyncHandler(async (req, res) => {
    const { page, limit } = req.query;

    if (page || limit) {
        const { pageNum, limitNum, offset } = getPaginationParams(page, limit);
        const { count, rows: notifications } = await Notification.findAndCountAll({
            include: [
                {
                    model: User,
                    as: 'User',
                    attributes: ['id', 'uuid', 'fullName', 'email', 'role']
                },
                {
                    model: User,
                    as: 'Creator',
                    attributes: ['id', 'uuid', 'fullName', 'email']
                }
            ],
            limit: limitNum,
            offset: offset,
            order: [['createdAt', 'DESC']]
        });

        const responseData = formatPaginatedResponse(count, notifications, pageNum, limitNum, 'notifications');
        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, responseData, "All notifications retrieved successfully.")
        );
    }

    const notifications = await Notification.findAll({
        include: [
            {
                model: User,
                as: 'User',
                attributes: ['id', 'uuid', 'fullName', 'email', 'role']
            },
            {
                model: User,
                as: 'Creator',
                attributes: ['id', 'uuid', 'fullName', 'email']
            }
        ],
        order: [['createdAt', 'DESC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            notifications,
            "All notifications retrieved successfully."
        )
    );
});

/**
 * @desc    Get notifications for logged-in user (User View)
 * @route   GET /api/admin/notifications/user/my-notifications
 * @access  Private (User/Admin)
 */
export const getUserNotifications = asyncHandler(async (req, res) => {
    const currentUserId = req.user.id;
    const { page, limit } = req.query;

    // Fetch user's active products
    const userActiveProducts = await Product.findAll({
        where: {
            userId: currentUserId,
            status: 'active'
        },
        attributes: ['product_name'],
        raw: true
    });
    const activeProductNames = userActiveProducts.map(p => p.product_name);

    const whereCondition = {
        status: 'active',
        [Op.or]: [
            { send_to: 'all' },
            { userId: currentUserId },
            ...(activeProductNames.length > 0 ? [{
                send_to: 'product',
                product_name: { [Op.in]: activeProductNames }
            }] : [])
        ]
    };

    if (page || limit) {
        const { pageNum, limitNum, offset } = getPaginationParams(page, limit);
        const { count, rows: notifications } = await Notification.findAndCountAll({
            where: whereCondition,
            include: [
                {
                    model: User,
                    as: 'Creator',
                    attributes: ['id', 'uuid', 'fullName', 'email']
                }
            ],
            limit: limitNum,
            offset: offset,
            order: [['createdAt', 'DESC']]
        });

        const responseData = formatPaginatedResponse(count, notifications, pageNum, limitNum, 'notifications');
        return res.status(HTTP_STATUS.OK).json(
            new ApiResponse(HTTP_STATUS.OK, responseData, "User notifications retrieved successfully.")
        );
    }

    const notifications = await Notification.findAll({
        where: whereCondition,
        include: [
            {
                model: User,
                as: 'Creator',
                attributes: ['id', 'uuid', 'fullName', 'email']
            }
        ],
        order: [['createdAt', 'DESC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            notifications,
            "User notifications retrieved successfully."
        )
    );
});

/**
 * @desc    Get a single notification strictly by UUID
 * @route   GET /api/admin/notifications/:uuid
 * @access  Private
 */
export const getNotificationById = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const notification = await Notification.findOne({
        where: { uuid },
        include: [
            {
                model: User,
                as: 'User',
                attributes: ['id', 'uuid', 'fullName', 'email']
            },
            {
                model: User,
                as: 'Creator',
                attributes: ['id', 'uuid', 'fullName', 'email']
            }
        ]
    });

    if (!notification) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Notification not found.");
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            notification,
            "Notification details retrieved successfully."
        )
    );
});

/**
 * @desc    Update a notification strictly by UUID (Admin)
 * @route   PUT /api/admin/notifications/:uuid
 * @access  Private (Admin)
 */
export const updateNotification = asyncHandler(async (req, res) => {
    const { uuid } = req.params;
    const { title, message, type, send_to, userId, product_name, status } = req.body;

    const notification = await Notification.findOne({ where: { uuid } });
    if (!notification) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Notification not found.");
    }

    if (title !== undefined) {
        if (!title || typeof title !== 'string' || !title.trim()) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Title cannot be empty.");
        }
        notification.title = title.trim();
    }

    if (message !== undefined) {
        if (!message || typeof message !== 'string' || !message.trim()) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Message cannot be empty.");
        }
        notification.message = message.trim();
    }

    if (type !== undefined) notification.type = type;
    if (status !== undefined) notification.status = status;

    if (send_to !== undefined) {
        notification.send_to = send_to;
        if (send_to === 'all') {
            notification.userId = null;
            notification.product_name = null;
        } else if (send_to === 'specific') {
            if (!userId && !notification.userId) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "userId is required when send_to is 'specific'.");
            }
            if (userId) {
                const targetUser = await User.findOne({
                    where: isNaN(userId) ? { uuid: userId } : { [Op.or]: [{ uuid: userId }, { id: userId }] }
                });
                if (!targetUser) {
                    throw new ApiError(HTTP_STATUS.NOT_FOUND, `Target user not found.`);
                }
                notification.userId = targetUser.id;
            }
            notification.product_name = null;
        } else if (send_to === 'product') {
            const targetProdName = product_name !== undefined ? product_name : notification.product_name;
            if (!targetProdName || typeof targetProdName !== 'string' || !targetProdName.trim()) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "product_name is required when send_to is 'product'.");
            }
            notification.product_name = targetProdName.trim();
            notification.userId = null;
        }
    } else {
        if (notification.send_to === 'product' && product_name !== undefined) {
            if (!product_name || typeof product_name !== 'string' || !product_name.trim()) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "product_name cannot be empty.");
            }
            notification.product_name = product_name.trim();
        } else if (notification.send_to === 'specific' && userId !== undefined) {
            const targetUser = await User.findOne({
                where: isNaN(userId) ? { uuid: userId } : { [Op.or]: [{ uuid: userId }, { id: userId }] }
            });
            if (!targetUser) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, `Target user not found.`);
            }
            notification.userId = targetUser.id;
        }
    }

    await sequelize.transaction(async (t) => {
        await notification.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            notification,
            "Notification updated successfully."
        )
    );
});

/**
 * @desc    Delete a notification strictly by UUID (Admin)
 * @route   DELETE /api/admin/notifications/:uuid
 * @access  Private (Admin)
 */
export const deleteNotification = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const notification = await Notification.findOne({ where: { uuid } });
    if (!notification) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, "Notification not found.");
    }

    await sequelize.transaction(async (t) => {
        await notification.destroy({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            null,
            "Notification deleted successfully."
        )
    );
});


