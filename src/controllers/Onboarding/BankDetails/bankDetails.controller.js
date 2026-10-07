import User from '../../../models/User.js';
import sequelize from '../../../config/db.js';
import { uploadToR2 } from '../../../utils/r2Helper.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { ApiError } from '../../../utils/ApiError.js';
import { ApiResponse } from '../../../utils/ApiResponse.js';
import { HTTP_STATUS } from '../../../utils/httpStatus.js';
import { getAuthenticatedUser } from '../../../utils/userHelper.js';
import { verifyBankDetails } from '../../../utils/verificationHelper.js';

/**
 * @desc    Save and verify user bank details
 * @route   PATCH /api/onboarding/bank-details/update
 * @access  Private (User)
 */
export const saveBankDetails = asyncHandler(async (req, res) => {
    const currentUser = await getAuthenticatedUser(req);
    const userId = currentUser.id;

    const { accountnumber, ifsccode } = req.body;

    // Validate body fields
    if (!accountnumber || !ifsccode) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "accountnumber and ifsccode are required.");
    }

    // Determine the bank proof file
    let bankProofUrl = currentUser.bank_proof;

    if (req.file) {
        // Upload new file to Cloudflare R2
        const uploadResult = await uploadToR2(req.file.buffer, {
            folder: 'bankDetails',
            publicId: `bank_${Date.now()}_${userId}`
        });
        bankProofUrl = uploadResult.secure_url;
    }

    if (!bankProofUrl) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Bank proof document is required.");
    }

    // Call reusable bank verification details helper
    const responseData = await verifyBankDetails(accountnumber, ifsccode);

    const resData = responseData.result || responseData.data || responseData;
    const fetchedHolderName = resData.name_at_bank;
    const fetchedBranchName = resData.branch;
    const fetchedBankName = resData.bank_name;

    if (!fetchedHolderName) {
        throw new ApiError(
            HTTP_STATUS.BAD_REQUEST,
            "Could not retrieve account holder name from bank verification."
        );
    }

    // Update user details inside an atomic transaction
    await sequelize.transaction(async (t) => {
        currentUser.bankname = fetchedBankName.trim();
        currentUser.accountnumber = String(accountnumber).trim();
        currentUser.ifsccode = String(ifsccode).trim();
        currentUser.accountHoldername = fetchedHolderName.trim();
        currentUser.branchName = fetchedBranchName.trim();
        currentUser.bank_proof = bankProofUrl;

        await currentUser.save({ transaction: t });
    });

    return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
            HTTP_STATUS.OK,
            {
                bankname: currentUser.bankname,
                accountnumber: currentUser.accountnumber,
                ifsccode: currentUser.ifsccode,
                accountHoldername: currentUser.accountHoldername,
                branchName: currentUser.branchName,
                bank_proof: currentUser.bank_proof
            },
            "Bank details updated and verified successfully!"
        )
    );
});
