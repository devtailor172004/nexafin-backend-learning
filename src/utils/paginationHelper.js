/**
 * Utility function to extract and normalize pagination parameters (page, limit, offset)
 * @param {string|number} page - Current page number
 * @param {string|number} limit - Items per page
 * @param {number} defaultLimit - Default limit if not provided (default 10)
 * @param {number} maxLimit - Max allowed limit (default 100)
 */
export const getPaginationParams = (page, limit, defaultLimit = 10, maxLimit = 100) => {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(maxLimit, parseInt(limit, 10) || defaultLimit));
    const offset = (pageNum - 1) * limitNum;
    return { pageNum, limitNum, offset };
};

/**
 * Utility function to format standardized paginated response data
 * @param {number} count - Total item count from DB
 * @param {Array} rows - Array of records
 * @param {number} pageNum - Current page number
 * @param {number} limitNum - Items per page
 * @param {string} keyName - Object property name for records list (default 'items')
 */
export const formatPaginatedResponse = (count, rows, pageNum, limitNum, keyName = 'items') => {
    const totalPages = Math.ceil(count / limitNum);
    return {
        [keyName]: rows,
        pagination: {
            totalItems: count,
            totalPages,
            currentPage: pageNum,
            limit: limitNum
        }
    };
};
