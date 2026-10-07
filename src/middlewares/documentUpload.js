import multer from 'multer';
import logger from '../utils/logger.js';

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    logger.info(`Uploaded File Details: ${file.originalname} (${file.mimetype})`);

    // Accept broadly at multer level — client mimetype is unreliable
    const allowedMimeTypes = [
        'image/jpeg',
        'image/png',
        'image/jpg',
        'application/pdf',
        'application/octet-stream' // fallback for mobile apps that don't set proper mimetype
    ];

    // Also check extension as a secondary signal
    const allowedExt = /\.(jpe?g|png|pdf)$/i;

    if (allowedMimeTypes.includes(file.mimetype) || allowedExt.test(file.originalname)) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed!'), false);
    }
};

const documentUpload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});

export default documentUpload;