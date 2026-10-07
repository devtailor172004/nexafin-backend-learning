import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import BlacklistedToken from '../models/BlacklistedToken.js';

// Optional token parser (attaches req.user if token present, doesn't block if missing or invalid)
export const parseToken = async (req, res, next) => {
    try {
        let token = req.headers.authorization;

        if (token && token.startsWith("Bearer ")) {
            token = token.split(" ")[1];

            const isBlacklisted = await BlacklistedToken.findOne({ where: { token } });
            if (isBlacklisted) {
                req.user = null;
                return next();
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded;
        } else {
            req.user = null;
        }
        next();
    } catch (error) {
        req.user = null;
        next();
    }
};

// Strict token verifier (blocks request if token missing)
export const verifyToken = async (req, res, next) => {
    try {
        let token = req.headers.authorization;

        if (token && token.startsWith("Bearer ")) {
            token = token.split(" ")[1];

            const isBlacklisted = await BlacklistedToken.findOne({ where: { token } });
            if (isBlacklisted) {
                return res.status(401).json({ success: false, message: "Token has been invalidated (logged out)." });
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Check if user is blocked in DB
            const user = await User.findByPk(decoded.id, { attributes: ['id', 'is_blocked'] });
            if (!user) {
                return res.status(401).json({ success: false, message: "User not found." });
            }

            if (user.is_blocked) {
                return res.status(403).json({ success: false, message: "Access Denied. Your account has been blocked" });
            }

            req.user = decoded;

            next();
        } else {
            return res.status(401).json({ success: false, message: "Access Denied. No token provided." });
        }
    } catch (error) {
        return res.status(401).json({ success: false, message: "Invalid Token" });
    }
};

// Admin role verification middleware
export const verifyAdmin = (req, res, next) => {
    verifyToken(req, res, () => {
        if (req.user && req.user.role === 'Admin') {
            next();
        } else {
            return res.status(403).json({ success: false, message: "Access Denied. Admin privilege required." });
        }
    });
};