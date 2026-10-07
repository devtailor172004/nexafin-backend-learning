import net from 'node:net';

/**
 * Extracts and validates the client's IP address from an Express request object.
 * Handles trust proxy mapping and trims IPv6-mapped IPv4 prefixes.
 * 
 * @param {Object} req - The Express request object
 * @returns {string|null} - The validated IP address or null if invalid
 */
export const getClientIp = (req) => {
    let ip = null;

    // Only trust req.ip if Express trust proxy is properly configured
    if (req.ip) {
        ip = req.ip;
    }

    // Fallback to direct socket connection
    if (!ip && req.socket?.remoteAddress) {
        ip = req.socket.remoteAddress;
    }

    if (!ip) {
        return null;
    }

    // IPv6 mapped IPv4 address
    // ::ffff:192.168.1.1 → 192.168.1.1
    if (ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
    }

    // Validate IP before storing it
    if (!net.isIP(ip)) {
        return null;
    }

    return ip;
};
