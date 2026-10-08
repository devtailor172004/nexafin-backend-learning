import pkg from 'sequelize';
const { Op } = pkg;

import PineLabsPayment from '../models/PineLabsPayment.js';
import { recordPaymentEvent } from './eventEngine.js';
import logger from '../utils/logger.js';

/**
 * Settlement engine.
 *
 * Settlement is the acquirer moving captured funds into the merchant account.
 * It is deliberately modeled separately from payment status:
 *
 *   PROCESSED + UNSETTLED  -> money captured from the customer, not yet paid out
 *   PROCESSED + SETTLED    -> funds credited to the merchant
 *
 * A payment can be refunded while settled, so the two axes stay independent.
 *
 * In a real deployment this is driven by the acquirer's settlement report (see
 * the Reconciliation Center). `runSettlement` is the deterministic local
 * implementation used by the sandbox and by the ops console for manual runs.
 */

export const SETTLEMENT_STATUS = Object.freeze({
    UNSETTLED: 'UNSETTLED',
    SETTLED: 'SETTLED',
    ON_HOLD: 'ON_HOLD'
});

const buildReference = () => `STL_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/**
 * Settles every PROCESSED + UNSETTLED payment older than `minAgeHours`.
 *
 * @param {object} [options]
 * @param {string} [options.provider]      provider code for the reference
 * @param {number} [options.minAgeHours]   minimum age before settlement (T+N window)
 * @param {number} [options.limit]         safety cap on rows per run
 * @returns {Promise<{reference:string, settledCount:number, settledAmount:number, payments:object[]}>}
 */
export const runSettlement = async ({ provider = 'PINELABS', minAgeHours = 0, limit = 500 } = {}) => {
    const cutoff = new Date(Date.now() - Number(minAgeHours) * 60 * 60 * 1000);
    const reference = buildReference();

    const eligible = await PineLabsPayment.findAll({
        where: {
            status: 'PROCESSED',
            settlementStatus: SETTLEMENT_STATUS.UNSETTLED,
            createdAt: { [Op.lte]: cutoff }
        },
        order: [['createdAt', 'ASC']],
        limit
    });

    let settledAmount = 0;
    const summary = [];

    for (const payment of eligible) {
        payment.settlementStatus = SETTLEMENT_STATUS.SETTLED;
        payment.settledAt = new Date();
        payment.settlementReference = reference;
        await payment.save();

        settledAmount += Number(payment.amount || 0);

        await recordPaymentEvent({
            orderId: payment.orderId,
            paymentId: payment.id,
            eventType: 'SETTLEMENT_SETTLED',
            source: 'SYSTEM',
            statusFrom: payment.status,
            statusTo: payment.status,
            message: `Settled under ${reference} (${provider})`,
            provider,
            metadata: { settlementReference: reference, amount: Number(payment.amount || 0) }
        });

        summary.push({
            paymentId: payment.uuid,
            amount: Number(payment.amount || 0),
            currency: payment.currency
        });
    }

    logger.info(`[Settlement] ${provider}: settled ${summary.length} payment(s) under ${reference}.`);

    return {
        reference,
        settledCount: summary.length,
        settledAmount: Number(settledAmount.toFixed(2)),
        payments: summary
    };
};

/**
 * Groups unsettled/settled amounts for the ops dashboard.
 */
export const getSettlementSummary = async () => {
    const [rows, settledToday] = await Promise.all([
        PineLabsPayment.findAll({
            attributes: [
                'settlementStatus',
                [pkg.fn('COUNT', pkg.col('id')), 'count'],
                [pkg.fn('SUM', pkg.col('amount')), 'amount']
            ],
            where: { status: 'PROCESSED' },
            group: ['settlementStatus'],
            raw: true
        }),
        PineLabsPayment.findAll({
            attributes: [
                [pkg.fn('COUNT', pkg.col('id')), 'count'],
                [pkg.fn('SUM', pkg.col('amount')), 'amount']
            ],
            where: {
                settlementStatus: SETTLEMENT_STATUS.SETTLED,
                settledAt: { [Op.gte]: (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })() }
            },
            raw: true
        })
    ]);

    const byStatus = {};
    rows.forEach((row) => {
        byStatus[row.settlementStatus] = {
            count: Number(row.count),
            amount: Number(row.amount || 0)
        };
    });

    return {
        unsettled: byStatus.UNSETTLED || { count: 0, amount: 0 },
        settled: byStatus.SETTLED || { count: 0, amount: 0 },
        onHold: byStatus.ON_HOLD || { count: 0, amount: 0 },
        settledToday: {
            count: Number(settledToday?.[0]?.count || 0),
            amount: Number(settledToday?.[0]?.amount || 0)
        }
    };
};

export default runSettlement;
