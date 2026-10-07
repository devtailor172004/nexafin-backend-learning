import logger from '../utils/logger.js';

export const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, originalUrl, ip } = req;
    const statusCode = res.statusCode;
    
    logger.http(`${method} ${originalUrl} ${statusCode} - ${duration}ms - IP: ${ip}`);
  });
  
  next();
};
