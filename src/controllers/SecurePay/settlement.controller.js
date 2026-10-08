import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../utils/httpStatus.js';
import { getSettlementSummary, runSettlement } from '../../securepay/settlement.js';

/**
 * @desc    Settlement overview for the ops console
 * @route   GET /api/securepay/settlements/summary
 * @access  Private (Admin)
 */
export const getSettlementOverview = asyncHandler(async (req, res) => {
    const summary = await getSettlementSummary();

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, {
            generatedAt: new Date().toISOString(),
            window: 'all-time (settledToday scoped to today)',
            ...summary
        }, 'Settlement summary fetched successfully.')
    );
});

/**
 * @desc    Trigger a settlement run for captured-but-unsettled payments
 * @route   POST /api/securepay/settlements/run
 * @access  Private (Admin)
 */
export const triggerSettlement = asyncHandler(async (req, res) => {
    const minAgeHours = Number(
        req.body?.minAgeHours ?? process.env.SETTLEMENT_MIN_AGE_HOURS ?? 0
    );

    const result = await runSettlement({
        provider: String(req.body?.provider || 'PINELABS').toUpperCase(),
        minAgeHours: Number.isFinite(minAgeHours) ? minAgeHours : 0
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(HTTP_STATUS.OK, result, `Settlement run complete: ${result.settledCount} payment(s).`)
    );
});
