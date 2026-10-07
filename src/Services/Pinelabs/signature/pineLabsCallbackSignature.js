import crypto from 'crypto';

/**
 * Pine Labs Return URL callback signature generate kare chhe.
 */
export const buildPineLabsCallbackRequestString = (callbackData) => {
    return Object.entries(callbackData)
        .filter(([key, value]) => {
            return (
                key !== 'signature' &&
                value !== undefined &&
                value !== null &&
                String(value).trim() !== ''
            );
        })
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
};


/**
 * Support confirmation: secret key is the Client Secret in Base64 encoded format.
 */
export const generatePineLabsCallbackSignature = (
    callbackData,
    secretKey
) => {
    if (!secretKey || !String(secretKey).trim()) {
        throw new Error(
            'NxPay callback secret key (Client Secret) is missing.'
        );
    }

    const requestString =
        buildPineLabsCallbackRequestString(callbackData);

    if (!requestString) {
        throw new Error(
            'Cannot generate NxPay signature from empty callback data.'
        );
    }

    // Decode Client Secret using base64 as confirmed by support
    const secretKeyBuffer = Buffer.from(
        String(secretKey).trim(),
        'base64'
    );

    return crypto
        .createHmac('sha256', secretKeyBuffer)
        .update(requestString, 'utf8')
        .digest('hex')
        .toUpperCase();
};


export const verifyPineLabsCallbackSignature = (
    callbackData,
    receivedSignature,
    secretKey
) => {
    const isTestMode = process.env.NODE_ENV !== 'production';

    // Local UAT/development testing bypass in non-production
    if (
        isTestMode &&
        (!secretKey ||
            secretKey === 'YOUR_PINE_LABS_SECRET_KEY' ||
            secretKey === 'YOUR_WEBHOOK_SECRET_KEY' ||
            String(secretKey).trim() === '')
    ) {
        return true;
    }

    if (!secretKey || String(secretKey).trim() === '') {
        throw new Error('NxPay callback secret key (Client Secret) is not configured.');
    }

    if (!receivedSignature) {
        return false;
    }

    const generatedSignature =
        generatePineLabsCallbackSignature(
            callbackData,
            secretKey
        );

    const generatedBuffer = Buffer.from(
        generatedSignature.toUpperCase(),
        'utf8'
    );

    const receivedBuffer = Buffer.from(
        String(receivedSignature)
            .trim()
            .toUpperCase(),
        'utf8'
    );

    // timingSafeEqual mate same length required chhe
    if (generatedBuffer.length !== receivedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        generatedBuffer,
        receivedBuffer
    );
};

