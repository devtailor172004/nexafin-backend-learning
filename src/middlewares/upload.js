import multer from 'multer';

// Use memory storage to store files in memory as buffer
const storage = multer.memoryStorage();

// Set up file filter for video files
const fileFilter = (req, file, cb) => {
    if (!file) {
        return cb(new Error('Only video files are allowed!'), false);
    }

    const mime = (file.mimetype || '').toLowerCase();
    const originalName = (file.originalname || '').toLowerCase();

    // Flexible video MIME and extension checks
    const isVideoMime = mime.startsWith('video/') || mime.includes('video') || mime === 'application/octet-stream' || mime === 'application/x-matroska';
    const isVideoExt = /\.(webm|mp4|mkv|mov|avi|ogv|3gp|m4v|flv|wmv)$/i.test(originalName);

    if (isVideoMime || isVideoExt) {
        cb(null, true);
    } else {
        cb(new Error('Only video files are allowed!'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB max limit for video
    }
});

export default upload;

