import logger from '../utils/logger.js';

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // Handle Sequelize validation and unique constraint errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    statusCode = 400;
    if (err.errors && err.errors.length > 0) {
      message = err.errors[0].message;
    }
  }

  // Sanitize user-facing message to refer to NxPay instead of Pine Labs
  if (typeof message === 'string') {
    message = message.replace(/pine\s*labs/gi, 'NxPay');
  }

  // Log error with request context using Winston
  logger.error(`${req.method} ${req.originalUrl} - Status: ${statusCode} - Error: ${message}`, {
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip
  });

  res.status(statusCode).json({
    success: false,
    message,
    errors: err.errors || []
  });
};

export default errorHandler;