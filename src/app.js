import './config/polyfill.js';
import dotenv from 'dotenv'
dotenv.config() // ← Must be first before any module-level env usage

import express from 'express'
import cors from 'cors'
import helmet from 'helmet';
import compression from 'compression';
import dbConnection from './config/db.js'
import { syncDatabase } from './config/syncDb.js'
import errorHandler from './middlewares/errorHandler.js'
import authRouter from './routes/Auth/auth.route.js';
import entitiesRoute from './routes/Entities/entities.route.js';
import businessInfoRoute from './routes/Onboarding/BusinessInfo/businessInfo.route.js';
import bankDetailsRoute from './routes/Onboarding/BankDetails/bankDetails.route.js';
import docKYCRoute from './routes/Onboarding/DocKYC/docKYC.route.js';
import { digilockerCallback } from './controllers/Onboarding/DocKYC/docKYC.controller.js';
import directorsRoute from './routes/Onboarding/Directors/directors.route.js';
import documentUploadRoute from './routes/Onboarding/DocumentUpload/documentUpload.route.js';
import userDocumentRoute from './routes/Onboarding/DocumentUpload/userDocument.route.js';
import adminKycRoute from './routes/Admin/KYC/adminKYC.route.js';
import adminDocumentUploadRoute from './routes/Admin/DocumentUpload/adminDocumentUpload.route.js';
import blockRoute from './routes/Admin/Block/userBlock.route.js';
import productRoute from './routes/Admin/Product/product.route.js'
import ipRoute from './routes/Admin/IP/ip.route.js';
import privatePasswordRoute from './routes/Admin/PrivatePassword/privatePassword.route.js';
import notificationRoute from './routes/Admin/Notifications/notification.route.js';
import pineLabsRoute from './routes/Payment/PineLabs/pineLabs.route.js';
import securePayOpsRoute from './routes/SecurePay/ops.route.js';
import securePayReconciliationRoute from './routes/SecurePay/reconciliation.route.js';
import securePaySettlementRoute from './routes/SecurePay/settlement.route.js';
import pineLabsSandboxRouter, { sandboxEnabled } from './sandbox/pineLabsSandbox.js';
import { globalLimiter, digilockerLimiter } from './middlewares/rateLimiter.js';
import './models/Otp.js';
import './models/Product.js';
import './models/MasterProduct.js';
import './models/ProductToken.js';
import './models/UserIp.js';
import './models/BlacklistedToken.js';
import './models/AdminSetting.js';
import './models/UserDocument.js';
import './models/Notifications.js';
import './models/PineLabsToken.js';
import './models/PineLabsOrder.js';
import './models/PineLabsPayment.js';
// SecurePay Lab models (idempotency, webhook ledger, timeline, audit)
import './models/IdempotencyKey.js';
import './models/ProviderWebhookEvent.js';
import './models/PaymentEvent.js';
import './models/AuditLog.js';
import './models/ReconciliationRun.js';
import './models/ReconciliationException.js';
import { requestLogger } from './middlewares/requestLogger.js';


const app = express()

// Trust proxy headers (needed for express-rate-limit to get correct client IPs when behind a proxy/load balancer)
app.set('trust proxy', 1);

// Log all incoming HTTP requests
app.use(requestLogger);

// Enforce HTTP Security Headers via Helmet
app.use(helmet({
    frameguard: { action: 'deny' }, // Clickjacking protection (X-Frame-Options: DENY)
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // HSTS (Strict-Transport-Security)
    noSniff: true, // MIME sniffing protection (X-Content-Type-Options: nosniff)
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, // Referrer Policy
    hidePoweredBy: true // Hide X-Powered-By Express header
}));

const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(item => item.trim())
    : [];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, Postman, server-to-server)
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked: ${origin} not allowed`));
    },
    credentials: true,
}));
app.use(compression());
// Raw body is required for provider webhook signature verification.
app.use('/api/payment/nxpay/webhook', express.raw({ type: '*/*' }));
// Separate raw-body path for the local mock webhook (no signature required).
app.use('/api/payment/nxpay/mock/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }))


// Apply Global Rate Limiter to all API routes
app.use('/api/', globalLimiter);

app.use('/api/auth', authRouter)
app.use('/api/entities', entitiesRoute);
app.use('/api/onboarding/bussiness-info', businessInfoRoute)
app.use('/api/onboarding/bank-details', bankDetailsRoute);
app.use('/api/onboarding/doc-kyc', docKYCRoute);
app.use('/api/onboarding/directors', directorsRoute);
app.use('/api/onboarding/document-upload', documentUploadRoute);
app.use('/api/onboarding/user-documents', userDocumentRoute);
app.use('/api/admin/kyc', adminKycRoute);
app.use('/api/admin/document-upload', adminDocumentUploadRoute);
app.use('/api/admin/block', blockRoute);
app.use('/api/admin/products', productRoute);
app.use('/api/admin/ip', ipRoute);
app.use('/api/admin/private-password', privatePasswordRoute);
app.use('/api/admin/notifications', notificationRoute);
app.use('/api/payment/nxpay', pineLabsRoute);
app.use('/api/securepay', securePayOpsRoute);
app.use('/api/securepay/reconciliation', securePayReconciliationRoute);
app.use('/api/securepay/settlements', securePaySettlementRoute);

// Pine Labs Plural-compatible SANDBOX provider.
// Point PINELABS_BASE_URL at it to exercise the entire payment pipeline with a
// real HTTP provider, without production credentials. Never mounted in production.
if (sandboxEnabled()) {
    app.use('/sandbox/pinelabs', pineLabsSandboxRouter);
}

app.get('/public/api/digilocker/callback', digilockerLimiter, digilockerCallback);


app.get('/', (req, res) => {
    return res.status(200).json({ success: true, message: "API is Working" });
})

app.get('/onboarding/success', (req, res) => {
    return res.status(200).json({ success: true, message: "Onboarding successful" });
})


app.use(errorHandler);

export default app;

