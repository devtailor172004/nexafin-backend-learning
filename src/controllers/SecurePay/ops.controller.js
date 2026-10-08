import pkg from 'sequelize';
const { Op, fn, col } = pkg;
import jwt from 'jsonwebtoken';

import User from '../../models/User.js';
import PineLabsOrder from '../../models/PineLabsOrder.js';
import PineLabsPayment from '../../models/PineLabsPayment.js';
import PaymentEvent from '../../models/PaymentEvent.js';
import ProviderWebhookEvent from '../../models/ProviderWebhookEvent.js';
import BlacklistedToken from '../../models/BlacklistedToken.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../utils/httpStatus.js';
import { getPaginationParams, formatPaginatedResponse } from '../../utils/paginationHelper.js';
import { buildPaymentExplanation } from '../../securepay/eventEngine.js';
import {
    subscribeLiveEvents,
    getRecentLiveEvents,
    getLiveSubscriberCount
} from '../../securepay/eventBus.js';
import { listProviders } from '../../securepay/providerRegistry.js';
import { getProviderLatency } from '../../securepay/providerMetrics.js';
import { selectProvider, evaluateFailover } from '../../securepay/router.js';
import ReconciliationException from '../../models/ReconciliationException.js';
import ReconciliationRun from '../../models/ReconciliationRun.js';
import { allowedTransitions } from '../../securepay/stateMachine.js';
import { getSettlementSummary } from '../../securepay/settlement.js';
import { getKycJourneyForUser } from '../../securepay/kycJourney.js';
import logger from '../../utils/logger.js';

const TERMINAL_SUCCESS = ['PROCESSED'];
const IN_FLIGHT = ['CREATED', 'PENDING', 'AUTHORIZED'];
const REFUND_STATUSES = ['REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'];

const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

const percentage = (part, whole) => {
    if (!whole) return 0;
    return Number(((part / whole) * 100).toFixed(2));
};

/**
 * @desc    Operations dashboard KPIs
 * @route   GET /api/securepay/dashboard
 * @access  Private (Admin)
 */
export const getOperationsDashboard = asyncHandler(async (req, res) => {
    const from = startOfToday();
    const todayFilter = { createdAt: { [Op.gte]: from } };

    const [statusRows, methodRows, todayTotals, ordersToday] = await Promise.all([
        PineLabsPayment.findAll({
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            where: todayFilter,
            group: ['status'],
            raw: true
        }),
        PineLabsPayment.findAll({
            attributes: ['paymentMethod', [fn('COUNT', col('id')), 'count']],
            where: todayFilter,
            group: ['paymentMethod'],
            raw: true
        }),
        PineLabsPayment.findAll({
            attributes: [
                [fn('COUNT', col('id')), 'count'],
                [fn('SUM', col('amount')), 'amount']
            ],
            where: todayFilter,
            raw: true
        }),
        PineLabsOrder.count({ where: todayFilter })
    ]);

    const byStatus = {};
    statusRows.forEach((row) => {
        byStatus[row.status] = Number(row.count);
    });

    const totalPayments = Number(todayTotals?.[0]?.count || 0);
    const grossAmount = Number(todayTotals?.[0]?.amount || 0);

    const succeeded = Object.entries(byStatus)
        .filter(([status]) => TERMINAL_SUCCESS.includes(status))
        .reduce((sum, [, count]) => sum + count, 0);
    const failed = Number(byStatus.FAILED || 0);
    const cancelled = Number(byStatus.CANCELLED || 0);
    const expired = Number(byStatus.EXPIRED || 0);
    const pending = Object.entries(byStatus)
        .filter(([status]) => IN_FLIGHT.includes(status))
        .reduce((sum, [, count]) => sum + count, 0);
    const refunds = Object.entries(byStatus)
        .filter(([status]) => REFUND_STATUSES.includes(status))
        .reduce((sum, [, count]) => sum + count, 0);

    // Webhook health + average processing delay.
    const [webhookTotal, webhookProcessed, webhookFailed, processedSamples] = await Promise.all([
        ProviderWebhookEvent.count({ where: todayFilter }),
        ProviderWebhookEvent.count({ where: { ...todayFilter, status: 'PROCESSED' } }),
        ProviderWebhookEvent.count({ where: { ...todayFilter, status: 'FAILED' } }),
        ProviderWebhookEvent.findAll({
            attributes: ['receivedAt', 'processedAt'],
            where: { ...todayFilter, status: 'PROCESSED' },
            order: [['processedAt', 'DESC']],
            limit: 100,
            raw: true
        })
    ]);

    const delays = processedSamples
        .filter((row) => row.receivedAt && row.processedAt)
        .map((row) => (new Date(row.processedAt).getTime() - new Date(row.receivedAt).getTime()) / 1000);

    const avgWebhookDelaySeconds = delays.length
        ? Number((delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(2))
        : null;

    // Reconciliation Center numbers (real counts, never fabricated).
    const [openExceptions, exceptionsByType, latestRun] = await Promise.all([
        ReconciliationException.count({ where: { status: { [Op.in]: ['OPEN', 'INVESTIGATING'] } } }),
        ReconciliationException.findAll({
            attributes: ['type', [fn('COUNT', col('id')), 'count']],
            where: { status: { [Op.in]: ['OPEN', 'INVESTIGATING'] } },
            group: ['type'],
            raw: true
        }),
        ReconciliationRun.findOne({ order: [['createdAt', 'DESC']] })
    ]);

    // Settlement is tracked separately from payment status.
    const settlement = await getSettlementSummary();

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            window: 'today',
            since: from.toISOString(),
            payments: {
                total: totalPayments,
                succeeded,
                failed,
                cancelled,
                expired,
                pending,
                refunds,
                successRate: percentage(succeeded, totalPayments),
                grossAmount,
                byStatus,
                byMethod: methodRows.reduce((acc, row) => {
                    acc[row.paymentMethod] = Number(row.count);
                    return acc;
                }, {})
            },
            orders: { total: ordersToday },
            webhooks: {
                total: webhookTotal,
                processed: webhookProcessed,
                failed: webhookFailed,
                duplicatesSuppressed: Math.max(0, webhookTotal - webhookProcessed - webhookFailed),
                avgDelaySeconds: avgWebhookDelaySeconds
            },
            realtime: {
                subscribers: getLiveSubscriberCount()
            },
            settlement: {
                implemented: true,
                ...settlement
            },
            reconciliation: {
                implemented: true,
                openExceptions,
                byType: exceptionsByType.reduce((acc, row) => {
                    acc[row.type] = Number(row.count);
                    return acc;
                }, {}),
                latestRun: latestRun ? {
                    uuid: latestRun.uuid,
                    source: latestRun.source,
                    exceptionCount: latestRun.exceptionCount,
                    matchedCount: latestRun.matchedCount,
                    completedAt: latestRun.completedAt
                } : null
            }
        }, 'Operations dashboard fetched successfully.')
    );
});

/**
 * @desc    Recent transactions with filters (drives the live ops table)
 * @route   GET /api/securepay/transactions/live
 * @access  Private (Admin)
 */
export const getLiveTransactions = asyncHandler(async (req, res) => {
    const { page = 1, limit = 25, status, method, orderId } = req.query;
    const { pageNum, limitNum, offset } = getPaginationParams(page, limit, 25, 100);

    const where = {};
    if (status) where.status = String(status).toUpperCase();
    if (method) where.paymentMethod = String(method).toUpperCase();
    if (orderId) where.nxPayOrderId = orderId;

    const { count, rows } = await PineLabsPayment.findAndCountAll({
        where,
        include: [{
            model: PineLabsOrder,
            as: 'PineLabsOrder',
            attributes: ['id', 'uuid', 'customerEmail', 'notes', 'currency']
        }],
        order: [['createdAt', 'DESC']],
        limit: limitNum,
        offset
    });

    const payments = rows.map((payment) => ({
        paymentId: payment.uuid,
        orderId: payment.PineLabsOrder?.uuid || null,
        customerEmail: payment.PineLabsOrder?.customerEmail || null,
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.paymentMethod,
        status: payment.status,
        provider: 'PINELABS',
        errorCode: payment.errorCode,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
    }));

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            formatPaginatedResponse(count, payments, pageNum, limitNum, 'transactions'),
            'Live transactions fetched successfully.'
        )
    );
});

/**
 * @desc    Provider health derived from real traffic (no synthetic numbers)
 * @route   GET /api/securepay/providers/health
 * @access  Private (Admin)
 */
export const getProviderHealth = asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const statusRows = await PineLabsPayment.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        where: { createdAt: { [Op.gte]: since } },
        group: ['status'],
        raw: true
    });

    const byStatus = {};
    statusRows.forEach((row) => { byStatus[row.status] = Number(row.count); });

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const succeeded = Number(byStatus.PROCESSED || 0);
    const failed = Number(byStatus.FAILED || 0);
    const successRate = percentage(succeeded, total);

    const ledgerRows = await ProviderWebhookEvent.findAll({
        attributes: ['receivedAt', 'processedAt'],
        where: { status: 'PROCESSED', createdAt: { [Op.gte]: since } },
        order: [['processedAt', 'DESC']],
        limit: 100,
        raw: true
    });

    const delays = ledgerRows
        .filter((r) => r.receivedAt && r.processedAt)
        .map((r) => (new Date(r.processedAt).getTime() - new Date(r.receivedAt).getTime()) / 1000);
    const avgDelay = delays.length ? Number((delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(2)) : null;

    // Honest status rules: with no traffic we cannot claim HEALTHY.
    let status = 'NO_TRAFFIC';
    if (total > 0) {
        if (successRate >= 95) status = 'HEALTHY';
        else if (successRate >= 80) status = 'DEGRADED';
        else status = 'UNHEALTHY';
    }

    const healthFor = (provider) => {
        const isPrimary = provider.code === 'PINELABS';
        // Latency is measured in-process (see securepay/providerMetrics.js).
        // The sample count is returned so a low-confidence figure is visible.
        const latency = getProviderLatency(provider.code);

        return {
            ...provider,
            status: provider.integrated ? (isPrimary ? status : 'NO_TRAFFIC') : 'NOT_INTEGRATED',
            windowHours: 24,
            metrics: isPrimary ? {
                transactions: total,
                succeeded,
                failed,
                successRate,
                avgWebhookDelaySeconds: avgDelay,
                latencyMs: latency.avgLatencyMs,
                latencyP95Ms: latency.p95LatencyMs,
                latencySamples: latency.samples,
                providerErrorRate: latency.errorRate
            } : {
                transactions: 0,
                succeeded: 0,
                failed: 0,
                successRate: 0,
                avgWebhookDelaySeconds: null,
                latencyMs: latency.avgLatencyMs,
                latencyP95Ms: latency.p95LatencyMs,
                latencySamples: latency.samples,
                providerErrorRate: latency.errorRate
            }
        };
    };

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            generatedAt: new Date().toISOString(),
            latencyWindow: 'in-process rolling window of the last 200 provider calls (resets on restart)',
            providers: listProviders().map(healthFor)
        }, 'Provider health fetched successfully.')
    );
});

/**
 * @desc    Timeline for a payment (or an order) by UUID
 * @route   GET /api/securepay/payments/:uuid/timeline
 * @access  Private (Admin)
 */
export const getPaymentTimeline = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const payment = await PineLabsPayment.findOne({ where: { uuid } });
    const order = payment
        ? await PineLabsOrder.findByPk(payment.orderId)
        : await PineLabsOrder.findOne({ where: { uuid } });

    if (!payment && !order) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Payment or order not found.');
    }

    const events = await PaymentEvent.findAll({
        where: payment
            ? { [Op.or]: [{ paymentId: payment.id }, { orderId: payment.orderId }] }
            : { orderId: order.id },
        order: [['createdAt', 'ASC'], ['id', 'ASC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            paymentId: payment?.uuid || null,
            orderId: order?.uuid || null,
            status: payment?.status || order?.pluralStatus || null,
            allowedNextStatuses: allowedTransitions(payment?.status || order?.pluralStatus),
            timeline: events.map((e) => ({
                at: e.createdAt,
                event: e.eventType,
                providerEvent: e.providerEventType,
                source: e.source,
                from: e.statusFrom,
                to: e.statusTo,
                message: e.message,
                rejected: e.isRejected
            }))
        }, 'Payment timeline fetched successfully.')
    );
});

/**
 * @desc    "Why did this payment fail?" explanation
 * @route   GET /api/securepay/payments/:uuid/explain
 * @access  Private (Admin)
 */
export const explainPayment = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const payment = await PineLabsPayment.findOne({ where: { uuid } });
    if (!payment) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Payment not found.');
    }

    const order = await PineLabsOrder.findByPk(payment.orderId);

    const events = await PaymentEvent.findAll({
        where: { [Op.or]: [{ paymentId: payment.id }, { orderId: payment.orderId }] },
        order: [['createdAt', 'ASC'], ['id', 'ASC']]
    });

    const explanation = buildPaymentExplanation({ payment, order, events });

    const webhookEvent = await ProviderWebhookEvent.findOne({
        where: { providerOrderId: payment.nxPayOrderId || order?.pluralOrderId || '__none__' },
        order: [['createdAt', 'DESC']]
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            ...explanation,
            webhook: webhookEvent ? {
                status: webhookEvent.status,
                eventType: webhookEvent.eventType,
                attempts: webhookEvent.attempts,
                receivedAt: webhookEvent.receivedAt,
                processedAt: webhookEvent.processedAt,
                signatureVerified: webhookEvent.signatureVerified
            } : null
        }, 'Payment explanation generated successfully.')
    );
});

/**
 * @desc    Customer 360 — one call for everything about a customer
 * @route   GET /api/securepay/customers/:uuid/overview
 * @access  Private (Admin)
 */
export const getCustomerOverview = asyncHandler(async (req, res) => {
    const { uuid } = req.params;

    const customer = await User.findOne({
        where: { uuid },
        attributes: { exclude: ['password', 'tpin'] }
    });

    if (!customer) {
        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Customer not found.');
    }

    const orders = await PineLabsOrder.findAll({
        where: { userId: customer.id },
        order: [['createdAt', 'DESC']],
        limit: 25
    });

    const orderIds = orders.map((o) => o.id);

    const payments = await PineLabsPayment.findAll({
        where: orderIds.length ? { orderId: { [Op.in]: orderIds } } : { orderId: -1 },
        order: [['createdAt', 'DESC']],
        limit: 50
    });

    const paymentUuids = payments.map((p) => p.uuid);

    const events = await PaymentEvent.findAll({
        where: orderIds.length ? { orderId: { [Op.in]: orderIds } } : { orderId: -1 },
        order: [['createdAt', 'DESC']],
        limit: 50
    });

    const failedCount = payments.filter((p) => p.status === 'FAILED').length;
    const refunds = payments.filter((p) => REFUND_STATUSES.includes(p.status));

    // Real KYC journey — was previously a hard-coded empty stub.
    const kycJourney = await getKycJourneyForUser(customer);

    const riskSignals = [];
    if (customer.is_blocked) riskSignals.push({ code: 'ACCOUNT_BLOCKED', severity: 'HIGH' });
    if (customer.kyc === 'Rejected') riskSignals.push({ code: 'KYC_REJECTED', severity: 'HIGH' });
    if (customer.pep_status === 'Yes') riskSignals.push({ code: 'PEP', severity: 'MEDIUM' });
    if (failedCount >= 3) riskSignals.push({ code: 'REPEATED_PAYMENT_FAILURES', severity: 'MEDIUM', count: failedCount });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            profile: {
                id: customer.id,
                uuid: customer.uuid,
                fullName: customer.fullName,
                email: customer.email,
                mobile: customer.mobile,
                role: customer.role,
                companyName: customer.company_name,
                businessType: customer.business_type,
                isBlocked: customer.is_blocked,
                createdAt: customer.createdAt
            },
            kyc: {
                status: kycJourney.kycStatus,
                step: kycJourney.kycStep,
                category: kycJourney.kycCategory,
                rejectionReason: kycJourney.rejectionReason,
                panStatus: customer.pan_verification_status,
                businessProofUrl: customer.business_proof_url,
                journeyImplemented: true,
                completionPercent: kycJourney.completionPercent,
                completed: kycJourney.completed,
                total: kycJourney.total,
                verified: kycJourney.verified,
                blockers: kycJourney.blockers,
                missing: kycJourney.missing,
                timeline: kycJourney.steps
            },
            bankAccounts: customer.accountnumber ? [{
                bankName: customer.bankname,
                accountHolderName: customer.accountHoldername,
                accountNumberMasked: customer.accountnumber
                    ? `****${String(customer.accountnumber).slice(-4)}`
                    : null,
                ifscCode: customer.ifsccode,
                branchName: customer.branchName
            }] : [],
            payments: payments.map((p) => ({
                paymentId: p.uuid,
                amount: Number(p.amount),
                currency: p.currency,
                method: p.paymentMethod,
                status: p.status,
                errorCode: p.errorCode,
                createdAt: p.createdAt
            })),
            refunds: refunds.map((p) => ({
                paymentId: p.uuid,
                amount: Number(p.amount),
                status: p.status,
                createdAt: p.createdAt
            })),
            // Not built yet — returned explicitly so the UI can render honestly.
            payouts: { implemented: false, items: [] },
            bills: { implemented: false, items: [] },
            supportTickets: { implemented: false, items: [] },
            riskSignals,
            timeline: events.map((e) => ({
                at: e.createdAt,
                event: e.eventType,
                source: e.source,
                from: e.statusFrom,
                to: e.statusTo,
                message: e.message
            })),
            counts: {
                orders: orders.length,
                payments: payments.length,
                refunds: refunds.length,
                paymentIds: paymentUuids.length
            }
        }, 'Customer 360 overview fetched successfully.')
    );
});

/**
 * Verifies a JWT supplied either via Authorization header or `?token=` query
 * (EventSource cannot set custom headers).
 */
const authenticateStreamRequest = async (req) => {
    let token = req.query.token;

    const header = req.headers.authorization;
    if (!token && header && header.startsWith('Bearer ')) {
        token = header.split(' ')[1];
    }

    if (!token) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Access Denied. No token provided.');
    }

    const blacklisted = await BlacklistedToken.findOne({ where: { token } });
    if (blacklisted) {
        throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Token has been invalidated (logged out).');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id, { attributes: ['id', 'role', 'is_blocked'] });

    if (!user) throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'User not found.');
    if (user.is_blocked) throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access Denied. Your account has been blocked.');
    if (user.role !== 'Admin') throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Admin privilege required.');

    return user;
};

/**
 * @desc    Server-Sent Events stream of live payment activity
 * @route   GET /api/securepay/stream?token=<JWT>
 * @access  Private (Admin)
 */
export const streamLiveEvents = asyncHandler(async (req, res) => {
    let user;
    try {
        user = await authenticateStreamRequest(req);
    } catch (error) {
        const status = error.statusCode || HTTP_STATUS.UNAUTHORIZED;
        return res.status(status).json({ success: false, message: error.message });
    }

    res.writeHead(HTTP_STATUS.OK, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable proxy buffering so events flush immediately.
        'X-Accel-Buffering': 'no'
    });

    const send = (eventName, data) => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('connected', {
        at: new Date().toISOString(),
        subscriberId: user.id,
        message: 'Live stream connected.'
    });

    // Replay a short backlog so a fresh dashboard is not empty.
    getRecentLiveEvents(25).forEach((event) => send('payment.event', event));

    const unsubscribe = subscribeLiveEvents((event) => {
        try {
            send('payment.event', event);
        } catch (error) {
            logger.warn(`SSE write failed: ${error.message}`);
        }
    });

    const heartbeat = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch {
            // connection is gone; cleanup happens on 'close'
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
    });
});

/**
 * @desc    Preview the Smart Router decision for a requirement, and the
 *          failover verdict for a specific payment
 * @route   GET /api/securepay/routing/preview
 * @access  Private (Admin)
 */
export const previewProviderRouting = asyncHandler(async (req, res) => {
    const { method, currency, country, paymentId } = req.query;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const statusRows = await PineLabsPayment.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        where: { createdAt: { [Op.gte]: since } },
        group: ['status'],
        raw: true
    });

    const byStatus = {};
    statusRows.forEach((row) => { byStatus[row.status] = Number(row.count); });
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const succeeded = Number(byStatus.PROCESSED || 0);

    const decision = selectProvider({
        method,
        currency,
        country,
        healthByProvider: {
            PINELABS: { successRate: percentage(succeeded, total), transactions: total }
        }
    });

    let failover = null;
    if (paymentId) {
        const payment = await PineLabsPayment.findOne({ where: { uuid: paymentId } });
        if (!payment) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Payment not found.');
        }

        const webhookReceived = (await ProviderWebhookEvent.count({
            where: {
                providerPaymentId: payment.nxPayPaymentId || '__none__',
                status: 'PROCESSED'
            }
        })) > 0;

        failover = {
            paymentId: payment.uuid,
            status: payment.status,
            ...evaluateFailover({ payment, webhookReceived })
        };
    }

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, { decision, failover }, 'Routing preview generated successfully.')
    );
});

export { REFUND_STATUSES, IN_FLIGHT, TERMINAL_SUCCESS };
