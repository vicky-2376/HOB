import prisma from "../config/db.js";
import { ApiError } from "../middlewares/errorHandler.js";
import { createRazorpayOrder as createRzpOrder, verifyRazorpaySignature } from "../services/razorpayService.js";
import { emitNotificationToUser } from "../socket/socketHandler.js";
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || "15");
const INITIAL_SANDBOX_BALANCE = 5000.0;
/**
 * @desc   Create Razorpay Order for Booking Escrow Deposit
 * @route  POST /api/payments/create-order
 * @access Private (Customer)
 */
export const createRazorpayOrder = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { bookingId, amount } = req.body;
        if (!bookingId) {
            throw new ApiError(400, "Booking ID is required.");
        }
        const booking = await prisma.booking.findUnique({
            where: { id: String(bookingId) },
            include: {
                service_request: {
                    include: { customer_profile: true },
                },
                worker_profile: true,
            },
        });
        if (!booking) {
            throw new ApiError(404, "Booking not found.");
        }
        const customerUserId = booking.service_request.customer_profile.userId;
        if (userId !== customerUserId) {
            throw new ApiError(403, "Only the customer who posted the task can initiate payment.");
        }
        const baseLabor = amount ? Number(amount) : (booking.service_request.budget || 400);
        const platformFee = Number(((baseLabor * PLATFORM_FEE_PERCENT) / 100).toFixed(2));
        const totalAmount = Number((baseLabor + platformFee).toFixed(2));
        const orderReceipt = `rcpt_${booking.id.slice(0, 8)}_${Date.now().toString().slice(-4)}`;
        const razorpayOrder = await createRzpOrder({
            amountInINR: totalAmount,
            receipt: orderReceipt,
            notes: {
                bookingId: booking.id,
                customerId: customerUserId,
                workerId: booking.worker_profile.userId,
                type: "ESCROW_BOOKING",
            },
        });
        res.status(200).json({
            success: true,
            order: razorpayOrder,
            breakdown: {
                laborAmount: baseLabor,
                platformFee,
                platformFeePercentage: PLATFORM_FEE_PERCENT,
                totalAmount,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Verify Razorpay Payment Signature and Lock Funds in Escrow Ledger
 * @route  POST /api/payments/verify
 * @access Private (Customer)
 */
export const verifyRazorpayPayment = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature, amount, method = "RAZORPAY_UPI", } = req.body;
        if (!bookingId || !razorpayOrderId || !razorpayPaymentId) {
            throw new ApiError(400, "bookingId, razorpayOrderId, and razorpayPaymentId are required.");
        }
        const cleanBookingId = String(bookingId);
        const booking = await prisma.booking.findUnique({
            where: { id: cleanBookingId },
            include: {
                service_request: {
                    include: { customer_profile: true },
                },
                worker_profile: true,
            },
        });
        if (!booking) {
            throw new ApiError(404, "Booking not found.");
        }
        const customerUserId = booking.service_request.customer_profile.userId;
        const workerUserId = booking.worker_profile.userId;
        if (userId !== customerUserId) {
            throw new ApiError(403, "Unauthorized.");
        }
        const isSignatureValid = verifyRazorpaySignature(String(razorpayOrderId), String(razorpayPaymentId), razorpaySignature ? String(razorpaySignature) : "mock_signature_approved");
        if (!isSignatureValid) {
            throw new ApiError(400, "Razorpay payment verification failed: Invalid signature.");
        }
        const totalAmount = amount ? Number(amount) : (booking.service_request.budget || 400);
        const result = await prisma.$transaction(async (tx) => {
            // 1. Create Payment in 'hold' status (Escrow Hold)
            const payment = await tx.payment.create({
                data: {
                    bookingId: cleanBookingId,
                    amount: totalAmount,
                    method: String(method).toUpperCase(),
                    status: "hold",
                    razorpayOrderId: String(razorpayOrderId),
                    razorpayPaymentId: String(razorpayPaymentId),
                    razorpaySignature: razorpaySignature ? String(razorpaySignature) : "mock_signature_approved",
                },
            });
            // 2. Create Double-entry Transaction record for Escrow Lock
            const transaction = await tx.transaction.create({
                data: {
                    paymentId: payment.id,
                    payerId: customerUserId,
                    payeeId: workerUserId,
                    amount: totalAmount,
                    settledAt: new Date(),
                },
            });
            // 3. Confirm booking and start task lifecycle
            const updatedBooking = await tx.booking.update({
                where: { id: cleanBookingId },
                data: { status: "confirmed" },
            });
            await tx.service_request.update({
                where: { id: booking.requestId },
                data: { status: "in_progress" },
            });
            return { payment, transaction, updatedBooking };
        }, { maxWait: 15000, timeout: 30000 });
        // Notify Tasker that funds are safely held in Escrow
        const notification = await prisma.notification.create({
            data: {
                userId: workerUserId,
                title: "Escrow Payment Secured! 🔒",
                message: `Poster deposited ₹${totalAmount} in Escrow for "${booking.service_request.title || "Task"}". Chat is now unlocked!`,
                type: "escrow_locked",
                data: {
                    bookingId: booking.id,
                    amount: totalAmount,
                },
            },
        });
        emitNotificationToUser(workerUserId, notification);
        res.status(200).json({
            success: true,
            message: "Escrow funds locked successfully. Chat and task unlocked!",
            payment: result.payment,
            booking: result.updatedBooking,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Create Razorpay Order for Wallet Top-Up
 * @route  POST /api/payments/wallet/topup/create-order
 * @access Private
 */
export const createWalletTopUpOrder = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { amount } = req.body;
        const topUpAmount = Number(amount);
        if (!topUpAmount || topUpAmount < 10) {
            throw new ApiError(400, "Minimum wallet top-up amount is ₹10.");
        }
        const receipt = `topup_${userId.slice(0, 8)}_${Date.now().toString().slice(-4)}`;
        const razorpayOrder = await createRzpOrder({
            amountInINR: topUpAmount,
            receipt,
            notes: {
                userId,
                type: "WALLET_TOPUP",
            },
        });
        res.status(200).json({
            success: true,
            order: razorpayOrder,
            amount: topUpAmount,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Verify Wallet Top-Up Payment and Credit Ledger
 * @route  POST /api/payments/wallet/topup/verify
 * @access Private
 */
export const verifyWalletTopUp = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature, amount, method = "RAZORPAY_UPI", } = req.body;
        if (!razorpayOrderId || !razorpayPaymentId) {
            throw new ApiError(400, "razorpayOrderId and razorpayPaymentId are required.");
        }
        const isSignatureValid = verifyRazorpaySignature(String(razorpayOrderId), String(razorpayPaymentId), razorpaySignature ? String(razorpaySignature) : "mock_signature_approved");
        if (!isSignatureValid) {
            throw new ApiError(400, "Top-up verification failed: Invalid signature.");
        }
        const topUpAmount = Number(amount);
        const result = await prisma.$transaction(async (tx) => {
            // 1. Create topup payment record in 'success' status
            const payment = await tx.payment.create({
                data: {
                    amount: topUpAmount,
                    method: "WALLET_TOPUP",
                    status: "success",
                    razorpayOrderId: String(razorpayOrderId),
                    razorpayPaymentId: String(razorpayPaymentId),
                    razorpaySignature: razorpaySignature ? String(razorpaySignature) : "mock_signature_approved",
                },
            });
            // 2. Create double-entry Credit Transaction
            const transaction = await tx.transaction.create({
                data: {
                    paymentId: payment.id,
                    payerId: userId,
                    payeeId: userId,
                    amount: topUpAmount,
                    settledAt: new Date(),
                },
            });
            return { payment, transaction };
        });
        // Notify user
        const notification = await prisma.notification.create({
            data: {
                userId,
                title: `₹${topUpAmount} Added to Wallet! 💳`,
                message: `Your wallet top-up via ${method} was successful. Current funds are available immediately.`,
                type: "task_match",
                data: { amount: topUpAmount },
            },
        });
        emitNotificationToUser(userId, notification);
        res.status(200).json({
            success: true,
            message: `₹${topUpAmount} added to wallet successfully!`,
            payment: result.payment,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Withdraw Funds from Wallet to Bank/UPI
 * @route  POST /api/payments/wallet/withdraw
 * @access Private
 */
export const requestWalletWithdrawal = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { amount, upiId, bankAccountNumber, ifscCode } = req.body;
        const withdrawAmount = Number(amount);
        if (!withdrawAmount || withdrawAmount < 50) {
            throw new ApiError(400, "Minimum withdrawal amount is ₹50.");
        }
        if (!upiId && (!bankAccountNumber || !ifscCode)) {
            throw new ApiError(400, "Please provide a valid UPI ID or Bank Account Details for payout.");
        }
        // Check available balance using double-entry ledger calculation
        const allUserPayments = await prisma.payment.findMany({
            where: {
                OR: [
                    { booking: { service_request: { customer_profile: { userId } } } },
                    { booking: { worker_profile: { userId } } },
                    { transaction: { some: { OR: [{ payerId: userId }, { payeeId: userId }] } } },
                ],
            },
            include: {
                booking: {
                    include: {
                        service_request: { include: { customer_profile: true } },
                        worker_profile: true,
                    },
                },
                transaction: true,
            },
        });
        const ledger = buildUserLedger(userId, allUserPayments);
        if (ledger.wallet.availableBalance < withdrawAmount) {
            throw new ApiError(400, `Insufficient available balance. You have ₹${ledger.wallet.availableBalance.toFixed(2)} available.`);
        }
        const payoutMethod = upiId ? `UPI: ${upiId}` : `BANK: ${bankAccountNumber} (${ifscCode})`;
        const result = await prisma.$transaction(async (tx) => {
            const payment = await tx.payment.create({
                data: {
                    amount: withdrawAmount,
                    method: "WALLET_WITHDRAWAL",
                    status: "success",
                    razorpayPaymentId: `payout_${Date.now()}`,
                },
            });
            const transaction = await tx.transaction.create({
                data: {
                    paymentId: payment.id,
                    payerId: userId,
                    payeeId: userId,
                    amount: withdrawAmount,
                    settledAt: new Date(),
                },
            });
            return { payment, transaction };
        });
        // Notify user
        const notification = await prisma.notification.create({
            data: {
                userId,
                title: `₹${withdrawAmount} Withdrawal Processed 🏦`,
                message: `Payout of ₹${withdrawAmount} sent to ${payoutMethod}. Transfer is instant.`,
                type: "task_completed",
                data: { amount: withdrawAmount, method: payoutMethod },
            },
        });
        emitNotificationToUser(userId, notification);
        res.status(200).json({
            success: true,
            message: `₹${withdrawAmount} withdrawal processed successfully to ${payoutMethod}.`,
            payment: result.payment,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Pay for Booking directly using Available Wallet Balance
 * @route  POST /api/payments/wallet/pay-booking
 * @access Private (Customer)
 */
export const payBookingWithWallet = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { bookingId } = req.body;
        if (!bookingId)
            throw new ApiError(400, "Booking ID is required.");
        const booking = await prisma.booking.findUnique({
            where: { id: String(bookingId) },
            include: {
                service_request: { include: { customer_profile: true } },
                worker_profile: true,
            },
        });
        if (!booking)
            throw new ApiError(404, "Booking not found.");
        const customerUserId = booking.service_request.customer_profile.userId;
        const workerUserId = booking.worker_profile.userId;
        if (userId !== customerUserId) {
            throw new ApiError(403, "Only the customer who posted the task can pay.");
        }
        const baseLabor = booking.service_request.budget || 400;
        const platformFee = Number(((baseLabor * PLATFORM_FEE_PERCENT) / 100).toFixed(2));
        const totalAmount = Number((baseLabor + platformFee).toFixed(2));
        // Check balance
        const allUserPayments = await prisma.payment.findMany({
            where: {
                OR: [
                    { booking: { service_request: { customer_profile: { userId } } } },
                    { booking: { worker_profile: { userId } } },
                    { transaction: { some: { OR: [{ payerId: userId }, { payeeId: userId }] } } },
                ],
            },
            include: {
                booking: {
                    include: {
                        service_request: { include: { customer_profile: true } },
                        worker_profile: true,
                    },
                },
                transaction: true,
            },
        });
        const ledger = buildUserLedger(userId, allUserPayments);
        if (ledger.wallet.availableBalance < totalAmount) {
            throw new ApiError(400, `Insufficient wallet balance. Total required is ₹${totalAmount}, but available is ₹${ledger.wallet.availableBalance.toFixed(2)}. Please add funds or pay via UPI.`);
        }
        const result = await prisma.$transaction(async (tx) => {
            // 1. Create Payment in 'hold' status
            const payment = await tx.payment.create({
                data: {
                    bookingId: booking.id,
                    amount: totalAmount,
                    method: "WALLET_BALANCE",
                    status: "hold",
                    razorpayPaymentId: `wallet_escrow_${Date.now()}`,
                },
            });
            // 2. Create Double-entry transaction
            const transaction = await tx.transaction.create({
                data: {
                    paymentId: payment.id,
                    payerId: customerUserId,
                    payeeId: workerUserId,
                    amount: totalAmount,
                    settledAt: new Date(),
                },
            });
            // 3. Confirm booking
            const updatedBooking = await tx.booking.update({
                where: { id: booking.id },
                data: { status: "confirmed" },
            });
            await tx.service_request.update({
                where: { id: booking.requestId },
                data: { status: "in_progress" },
            });
            return { payment, transaction, updatedBooking };
        });
        // Notify Tasker
        const notification = await prisma.notification.create({
            data: {
                userId: workerUserId,
                title: "Escrow Payment Secured! 🔒",
                message: `Poster paid ₹${totalAmount} from Wallet Escrow for "${booking.service_request.title || "Task"}". Chat is unlocked!`,
                type: "escrow_locked",
                data: { bookingId: booking.id, amount: totalAmount },
            },
        });
        emitNotificationToUser(workerUserId, notification);
        res.status(200).json({
            success: true,
            message: "Paid via Escrow Wallet successfully. Task is now in progress!",
            payment: result.payment,
            booking: result.updatedBooking,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Release Escrow Payment to Worker
 * @route  POST /api/payments/release/:paymentId
 * @access Private
 */
export const releaseEscrowPayment = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const paymentId = String(req.params.paymentId);
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        if (!paymentId)
            throw new ApiError(400, "Payment ID is required.");
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: {
                booking: {
                    include: {
                        service_request: {
                            include: { customer_profile: true },
                        },
                        worker_profile: true,
                    },
                },
            },
        });
        if (!payment || !payment.booking) {
            throw new ApiError(404, "Payment record not found.");
        }
        if (payment.status !== "hold") {
            throw new ApiError(400, `Cannot release payment with status "${payment.status}". Must be in "hold".`);
        }
        const customerUserId = payment.booking.service_request.customer_profile.userId;
        const workerUserId = payment.booking.worker_profile.userId;
        if (userId !== customerUserId && userId !== workerUserId) {
            throw new ApiError(403, "Unauthorized.");
        }
        const totalAmount = payment.amount;
        const platformCommission = Number(((totalAmount * PLATFORM_FEE_PERCENT) / 100).toFixed(2));
        const workerPayout = Number((totalAmount - platformCommission).toFixed(2));
        const updated = await prisma.$transaction(async (tx) => {
            // 1. Mark payment as released
            const updatedPayment = await tx.payment.update({
                where: { id: paymentId },
                data: { status: "released" },
            });
            // 2. Record Worker Payout Credit Transaction
            const workerPayoutTx = await tx.transaction.create({
                data: {
                    paymentId: payment.id,
                    payerId: customerUserId,
                    payeeId: workerUserId,
                    amount: workerPayout,
                    settledAt: new Date(),
                },
            });
            return {
                payment: updatedPayment,
                payoutBreakdown: {
                    totalAmount,
                    workerPayout,
                    workerPayoutPercentage: 100 - PLATFORM_FEE_PERCENT,
                    platformCommission,
                    platformCommissionPercentage: PLATFORM_FEE_PERCENT,
                },
                transaction: workerPayoutTx,
            };
        }, { maxWait: 15000, timeout: 30000 });
        // Notify Worker of credited wallet payout
        const notification = await prisma.notification.create({
            data: {
                userId: workerUserId,
                title: `₹${workerPayout} Credited to Wallet! 🎉`,
                message: `Task completed and 85% payout released for "${payment.booking.service_request.title || "Task"}".`,
                type: "task_completed",
                data: { bookingId: payment.booking.id, amount: workerPayout },
            },
        });
        emitNotificationToUser(workerUserId, notification);
        res.status(200).json({
            success: true,
            message: "Escrow payment released to worker wallet successfully.",
            data: updated,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Refund Escrow Payment to Customer
 * @route  POST /api/payments/refund/:paymentId
 * @access Private
 */
export const refundEscrowPayment = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const paymentId = String(req.params.paymentId);
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        if (!paymentId)
            throw new ApiError(400, "Payment ID is required.");
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: {
                booking: {
                    include: {
                        service_request: {
                            include: { customer_profile: true },
                        },
                        worker_profile: true,
                    },
                },
            },
        });
        if (!payment || !payment.booking) {
            throw new ApiError(404, "Payment record not found.");
        }
        if (payment.status !== "hold") {
            throw new ApiError(400, `Cannot refund payment with status "${payment.status}".`);
        }
        const customerUserId = payment.booking.service_request.customer_profile.userId;
        const workerUserId = payment.booking.worker_profile.userId;
        const refundResult = await prisma.$transaction(async (tx) => {
            // 1. Mark payment as refunded
            const updatedPayment = await tx.payment.update({
                where: { id: paymentId },
                data: { status: "refunded" },
            });
            // 2. Create double-entry Refund Transaction to Customer
            const refundTx = await tx.transaction.create({
                data: {
                    paymentId: payment.id,
                    payerId: workerUserId,
                    payeeId: customerUserId,
                    amount: payment.amount,
                    settledAt: new Date(),
                },
            });
            return { updatedPayment, refundTx };
        }, { maxWait: 15000, timeout: 30000 });
        // Notify Customer of refunded escrow
        const notification = await prisma.notification.create({
            data: {
                userId: customerUserId,
                title: `₹${payment.amount} Escrow Refunded 🔄`,
                message: `Escrow funds refunded back to your wallet for "${payment.booking.service_request.title || "Task"}".`,
                type: "escrow_refunded",
                data: { bookingId: payment.booking.id, amount: payment.amount },
            },
        });
        emitNotificationToUser(customerUserId, notification);
        res.status(200).json({
            success: true,
            message: "Escrow funds refunded back to customer successfully.",
            data: refundResult,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * Helper to compute Normalized Double-Entry Transactions and Balances
 */
const buildUserLedger = (userId, payments) => {
    const transactions = [];
    let totalCredits = 0;
    let totalDebits = 0;
    let escrowHold = 0;
    let totalLifetimeEarnings = 0;
    for (const p of payments) {
        const customerUserId = p.booking?.service_request?.customer_profile?.userId;
        const workerUserId = p.booking?.worker_profile?.userId;
        const isCustomer = customerUserId === userId;
        const isWorker = workerUserId === userId;
        const taskTitle = p.booking?.service_request?.title || (p.method === "WALLET_TOPUP" ? "Wallet Top-Up" : p.method === "WALLET_WITHDRAWAL" ? "Bank Withdrawal" : "Escrow Payment");
        const paymentStatus = (p.status || "").toLowerCase();
        const payerObj = {
            id: customerUserId || userId,
            name: p.booking?.service_request?.customer_profile?.user?.name || "User",
            phone: p.booking?.service_request?.customer_profile?.user?.phone,
        };
        const payeeObj = {
            id: workerUserId || userId,
            name: p.booking?.worker_profile?.user?.name || "Platform",
            phone: p.booking?.worker_profile?.user?.phone,
        };
        // 1. Direct Wallet Top-Up
        if (p.method === "WALLET_TOPUP" || p.method === "TOPUP") {
            totalCredits += p.amount;
            transactions.push({
                id: `topup-${p.id}`,
                paymentId: p.id,
                type: "CREDIT",
                amount: p.amount,
                rawAmount: p.amount,
                status: "SUCCESS",
                description: "Instant Wallet Top-up (Razorpay)",
                method: "Razorpay UPI/Card",
                settledAt: p.createdAt,
                taskTitle: "Wallet Deposit",
                role: "poster",
                payer: payerObj,
                payee: payeeObj,
                payment: p,
            });
            continue;
        }
        // 2. Direct Wallet Withdrawal
        if (p.method === "WALLET_WITHDRAWAL" || p.method === "WITHDRAWAL") {
            totalDebits += p.amount;
            transactions.push({
                id: `withdraw-${p.id}`,
                paymentId: p.id,
                type: "DEBIT",
                amount: p.amount,
                rawAmount: -p.amount,
                status: "SUCCESS",
                description: "Bank/UPI Payout Transfer",
                method: "IMPS/UPI Payout",
                settledAt: p.createdAt,
                taskTitle: "Withdrawal",
                role: "tasker",
                payer: payerObj,
                payee: payeeObj,
                payment: p,
            });
            continue;
        }
        // 3. Booking Escrow Flows
        if (isCustomer) {
            if (paymentStatus === "hold") {
                // Escrow Hold: Money locked from Poster available balance into Escrow
                escrowHold += p.amount;
                transactions.push({
                    id: `escrow-${p.id}`,
                    paymentId: p.id,
                    type: "ESCROW_HOLD",
                    amount: p.amount,
                    rawAmount: -p.amount,
                    status: "ESCROW_HOLD",
                    description: `Escrow Payment locked for Task: ${taskTitle}`,
                    method: p.method || "RAZORPAY_UPI",
                    settledAt: p.createdAt,
                    taskTitle,
                    role: "poster",
                    payer: payerObj,
                    payee: payeeObj,
                    payment: p,
                });
            }
            else if (paymentStatus === "released") {
                // Escrow Released: Money deducted/settled from Poster to Tasker
                totalDebits += p.amount;
                transactions.push({
                    id: `debit-${p.id}`,
                    paymentId: p.id,
                    type: "DEBIT",
                    amount: p.amount,
                    rawAmount: -p.amount,
                    status: "ESCROW_RELEASED",
                    description: `Escrow Payment settled for Task: ${taskTitle}`,
                    method: p.method || "RAZORPAY_UPI",
                    settledAt: p.transaction?.[0]?.settledAt || p.createdAt,
                    taskTitle,
                    role: "poster",
                    payer: payerObj,
                    payee: payeeObj,
                    payment: p,
                });
            }
            else if (paymentStatus === "refunded") {
                // Refund: Returned back to Poster Available Balance
                totalCredits += p.amount;
                transactions.push({
                    id: `refund-${p.id}`,
                    paymentId: p.id,
                    type: "CREDIT",
                    amount: p.amount,
                    rawAmount: p.amount,
                    status: "REFUNDED",
                    description: `Escrow Refund for Cancelled Task: ${taskTitle}`,
                    method: p.method || "RAZORPAY_UPI",
                    settledAt: p.transaction?.[0]?.settledAt || p.createdAt,
                    taskTitle,
                    role: "poster",
                    payer: payerObj,
                    payee: payeeObj,
                    payment: p,
                });
            }
        }
        if (isWorker) {
            const workerPayout = p.transaction?.find((t) => t.payeeId === userId)?.amount ||
                Number((p.amount * (1 - PLATFORM_FEE_PERCENT / 100)).toFixed(2));
            if (paymentStatus === "released") {
                // Worker Earnings: Credit to Worker
                totalCredits += workerPayout;
                totalLifetimeEarnings += workerPayout;
                transactions.push({
                    id: `credit-${p.id}`,
                    paymentId: p.id,
                    type: "CREDIT",
                    amount: workerPayout,
                    rawAmount: workerPayout,
                    status: "SUCCESS",
                    description: `Payment received for Task: ${taskTitle}`,
                    method: p.method || "ESCROW_RELEASE",
                    settledAt: p.transaction?.[0]?.settledAt || p.createdAt,
                    taskTitle,
                    role: "tasker",
                    payer: payerObj,
                    payee: payeeObj,
                    payment: p,
                });
            }
            else if (paymentStatus === "hold") {
                // Pending incoming Escrow for Worker (Does not increase available balance until OTP release)
                transactions.push({
                    id: `pending-${p.id}`,
                    paymentId: p.id,
                    type: "ESCROW_HOLD",
                    amount: workerPayout,
                    rawAmount: workerPayout,
                    status: "PENDING",
                    description: `Incoming Escrow locked for Task: ${taskTitle}`,
                    method: p.method || "ESCROW_LOCKED",
                    settledAt: p.createdAt,
                    taskTitle,
                    role: "tasker",
                    payer: payerObj,
                    payee: payeeObj,
                    payment: p,
                });
            }
        }
    }
    // Dynamic double-entry formula:
    // Available Balance = Initial Base + Total Credits - Total Debits - Escrow Hold
    const availableBalance = Math.max(0, INITIAL_SANDBOX_BALANCE + totalCredits - totalDebits - escrowHold);
    return {
        wallet: {
            availableBalance: Number(availableBalance.toFixed(2)),
            escrowHold: Number(escrowHold.toFixed(2)),
            totalLifetimeEarnings: Number(totalLifetimeEarnings.toFixed(2)),
            totalCredits: Number(totalCredits.toFixed(2)),
            totalDebits: Number(totalDebits.toFixed(2)),
            transactionsCount: transactions.length,
        },
        transactions,
    };
};
/**
 * @desc   Get Full Wallet Ledger Breakdown for User (Pure Database Query)
 * @route  GET /api/payments/wallet
 * @access Private
 */
export const getWalletLedger = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const payments = await prisma.payment.findMany({
            where: {
                OR: [
                    { booking: { service_request: { customer_profile: { userId } } } },
                    { booking: { worker_profile: { userId } } },
                    { transaction: { some: { OR: [{ payerId: userId }, { payeeId: userId }] } } },
                ],
            },
            include: {
                booking: {
                    include: {
                        service_request: {
                            include: {
                                customer_profile: {
                                    include: { user: { select: { id: true, name: true, phone: true } } },
                                },
                            },
                        },
                        worker_profile: {
                            include: { user: { select: { id: true, name: true, phone: true } } },
                        },
                    },
                },
                transaction: {
                    include: {
                        payer: { select: { id: true, name: true, phone: true } },
                        payee: { select: { id: true, name: true, phone: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
        const ledgerData = buildUserLedger(userId, payments);
        res.status(200).json({
            success: true,
            wallet: ledgerData.wallet,
            transactions: ledgerData.transactions,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get All Transactions
 * @route  GET /api/payments/transactions
 * @access Private
 */
export const getMyTransactions = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const payments = await prisma.payment.findMany({
            where: {
                OR: [
                    { booking: { service_request: { customer_profile: { userId } } } },
                    { booking: { worker_profile: { userId } } },
                    { transaction: { some: { OR: [{ payerId: userId }, { payeeId: userId }] } } },
                ],
            },
            include: {
                booking: {
                    include: {
                        service_request: {
                            include: {
                                customer_profile: {
                                    include: { user: { select: { id: true, name: true, phone: true } } },
                                },
                            },
                        },
                        worker_profile: {
                            include: { user: { select: { id: true, name: true, phone: true } } },
                        },
                    },
                },
                transaction: {
                    include: {
                        payer: { select: { id: true, name: true, phone: true } },
                        payee: { select: { id: true, name: true, phone: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
        const ledgerData = buildUserLedger(userId, payments);
        res.status(200).json({
            success: true,
            count: ledgerData.transactions.length,
            transactions: ledgerData.transactions,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get Payment by Booking ID
 * @route  GET /api/payments/booking/:bookingId
 * @access Private
 */
export const getPaymentByBooking = async (req, res, next) => {
    try {
        const bookingId = String(req.params.bookingId);
        if (!bookingId)
            throw new ApiError(400, "Booking ID is required.");
        const payments = await prisma.payment.findMany({
            where: { bookingId },
            include: {
                transaction: {
                    include: {
                        payer: { select: { id: true, name: true } },
                        payee: { select: { id: true, name: true } },
                    },
                },
            },
        });
        res.status(200).json({
            success: true,
            payments,
        });
    }
    catch (error) {
        next(error);
    }
};
