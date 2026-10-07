import r2Client from '../config/r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import { ApiError } from './ApiError.js';
import { HTTP_STATUS } from './httpStatus.js';
dotenv.config();

const mimeToExt = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
    'video/webm': '.webm'
};

export function getMimeType(buffer) {
    if (!buffer || buffer.length < 4) return 'application/octet-stream';
    
    const hex = buffer.toString('hex', 0, 4).toUpperCase();
    if (hex === '89504E47') return 'image/png';
    if (hex.startsWith('FFD8FF')) return 'image/jpeg';
    if (hex === '25504446') return 'application/pdf';
    if (hex === '1A45DFA3') return 'video/webm';
    if (hex === '52494646') {
        const typeHex = buffer.toString('hex', 8, 12).toUpperCase();
        if (typeHex === '41565920' || typeHex === '41564920') return 'video/x-msvideo';
    }
    
    if (buffer.length >= 8) {
        const ftypHex = buffer.toString('hex', 4, 8).toUpperCase();
        if (ftypHex === '66747970') {
            return 'video/mp4';
        }
    }
    
    return 'application/octet-stream';
}

/**
 * Uploads a file buffer to Cloudflare R2.
 * 
 * @param {Buffer} fileBuffer - The file buffer to upload
 * @param {Object} options - Upload options
 * @param {string} options.folder - The destination folder prefix in R2
 * @param {string} options.publicId - The unique file key/ID
 * @returns {Promise<Object>} - Resolves with an object containing secure_url
 */
export const uploadToR2 = async (fileBuffer, { folder, publicId }) => {
    const mimeType = getMimeType(fileBuffer);
    
    // Validate file type (only pdf, png, jpg/jpeg, and video allowed)
    const isAllowed = mimeType === 'application/pdf' || 
                      mimeType === 'image/png' || 
                      mimeType === 'image/jpeg' || 
                      mimeType.startsWith('video/');

    if (!isAllowed) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Invalid file format. Only PDF, PNG, JPG, JPEG, and Video files are allowed."
        );
    }

    const ext = mimeToExt[mimeType] || '';
    
    let key = folder ? `${folder}/${publicId}` : publicId;
    if (ext && !key.toLowerCase().endsWith(ext)) {
        key += ext;
    }

    const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME;
    const publicBaseUrl = process.env.CLOUDFLARE_R2_PUBLIC_URL;

    await r2Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType
    }));

    const secure_url = `${publicBaseUrl.replace(/\/$/, '')}/${key}`;

    return {
        secure_url
    };
};
