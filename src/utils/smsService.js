import dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import logger from './logger.js';

const clean = (v) => (typeof v === 'string' ? v.trim() : v);

export const sendRegistrationSMS = async ({ mobile, password, url }) => {
    try {
        const username = clean(process.env.MOBIROUTE_USERNAME);
        const smsPassword = clean(process.env.MOBIROUTE_PASSWORD);
        const apiKey = clean(process.env.MOBIROUTE_ACCESS_KEY);
        const senderId = clean(process.env.MOBIROUTE_SENDER_ID);
        const baseUrl = clean(process.env.MOBIROUTE_API_URL);
        const msgType = clean(process.env.MOBIROUTE_TYPE);
        const entityId = clean(process.env.MOBIROUTE_ENTITY_ID);
        const templateId = clean(process.env.MOBIROUTE_TEMPLATE_ID);

        const messageText = `Dear User,\nYour One-Time Password (OTP) for accessing Nixasoft Fintech Pvt. Ltd. is: ${password}\nThis OTP is valid for 5 minutes.\nFor your security, please do not share this code with anyone.\nThank you,\nTeam Nixasoft`;
        const params = new URLSearchParams();

        // Dynamically detect authentication based on the URL version
        if (baseUrl && baseUrl.includes('_v2')) {
            const activeKey = apiKey || smsPassword;
            if (activeKey) params.append('apikey', activeKey);
            if (username) params.append('username', username);
        } else {
            if (username) params.append('username', username);
            if (smsPassword) params.append('password', smsPassword);
        }

        if (msgType) params.append('type', msgType);
        if (senderId) params.append('sender', senderId);
        if (entityId) params.append('entityId', entityId);
        if (templateId) params.append('templateId', templateId);

        // Prefix 91 for Indian numbers if they are 10 digits
        let formattedMobile = mobile ? mobile.toString().trim() : '';
        if (formattedMobile.length === 10) {
            formattedMobile = `91${formattedMobile}`;
        }
        params.append('mobile', formattedMobile);
        params.append('message', messageText);

        const mask = (v) => (v ? `${v[0]}***${v[v.length - 1]}(len:${v.length})` : '(missing)');
        logger.info(`[SMS Service] Sending to ${mobile} | username=${mask(username)} password=${mask(smsPassword)}`);

        const response = await fetch(`${baseUrl}?${params.toString()}`);

        const responseData = await response.text();
        logger.info(`[SMS Service] API Response: ${responseData}`);

        const isSuccess = response.ok && (responseData.includes('SUCCESS') || (!responseData.includes('ERR_') && !responseData.includes('ERROR')));

        let errorMsg = responseData;
        if (!isSuccess) {
            const maskedParams = params.toString()
                .replace(/password=[^&]+/g, 'password=***')
                .replace(/apikey=[^&]+/g, 'apikey=***');
            errorMsg = `${responseData} | Sent to: ${baseUrl} with params: ${maskedParams}`;
        }
        return { success: isSuccess, response: errorMsg };
    } catch (error) {
        logger.error(`[SMS Service] Error sending SMS to ${mobile}:`, error);
        return { success: false, error: error.message };
    }
};