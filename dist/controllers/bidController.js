import prisma from "../config/db.js";
import { ApiError } from "../middlewares/errorHandler.js";
import { emitNotificationToUser } from "../socket/socketHandler.js";
/**
 * @desc   Tasker places a Bid / Application on an open Task
 * @route  POST /api/services/requests/:id/bids
 * @access Private (Worker / Tasker)
 */
export const createBid = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const requestId = String(req.params.id);
        const { proposedPrice, message } = req.body;
        if (!requestId)
            throw new ApiError(400, "Task request ID is required.");
        if (proposedPrice === undefined || isNaN(Number(proposedPrice)) || Number(proposedPrice) <= 0) {
            throw new ApiError(400, "A valid proposed price is required.");
        }
        const task = await prisma.service_request.findUnique({
            where: { id: requestId },
            include: {
                customer_profile: {
                    include: { user: true },
                },
            },
        });
        if (!task) {
            throw new ApiError(404, "Task request not found.");
        }
        if (task.status !== "pending") {
            throw new ApiError(400, `Cannot bid on a task that is currently '${task.status}'.`);
        }
        if (task.customer_profile.userId === userId) {
            throw new ApiError(400, "You cannot place a bid on your own posted task.");
        }
        let workerProfile = await prisma.worker_profile.findFirst({
            where: { userId },
        });
        if (!workerProfile) {
            workerProfile = await prisma.worker_profile.create({
                data: {
                    userId,
                    skills: "Errands, Delivery, Quick Tasks",
                    skillsList: ["Errands", "Delivery"],
                    hourlyRate: Number(proposedPrice),
                    isAvailable: true,
                    avgRating: 5.0,
                },
            });
        }
        const existingBid = await prisma.bid.findFirst({
            where: {
                requestId,
                workerId: workerProfile.id,
            },
        });
        let bid;
        if (existingBid) {
            bid = await prisma.bid.update({
                where: { id: existingBid.id },
                data: {
                    proposedPrice: Number(proposedPrice),
                    message: message ? String(message).trim() : existingBid.message,
                    status: "pending",
                },
                include: {
                    worker_profile: {
                        include: { user: { select: { id: true, name: true, avatarUrl: true } } },
                    },
                },
            });
        }
        else {
            bid = await prisma.bid.create({
                data: {
                    requestId,
                    workerId: workerProfile.id,
                    proposedPrice: Number(proposedPrice),
                    message: message ? String(message).trim() : null,
                    status: "pending",
                },
                include: {
                    worker_profile: {
                        include: { user: { select: { id: true, name: true, avatarUrl: true } } },
                    },
                },
            });
        }
        const posterUserId = task.customer_profile.userId;
        const notification = await prisma.notification.create({
            data: {
                userId: posterUserId,
                title: `New Bid on "${task.title || "Your Task"}"`,
                message: `${req.user?.name || "A tasker"} bid ₹${proposedPrice}: "${(message || "").slice(0, 40)}"`,
                type: "bid_received",
                data: {
                    taskId: task.id,
                    bidId: bid.id,
                    proposedPrice: Number(proposedPrice),
                },
            },
        });
        emitNotificationToUser(posterUserId, notification);
        res.status(201).json({
            success: true,
            message: "Bid submitted successfully. Task poster has been notified.",
            bid,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get all Bids placed on a specific Task
 * @route  GET /api/services/requests/:id/bids
 * @access Private
 */
export const getBidsForTask = async (req, res, next) => {
    try {
        const requestId = String(req.params.id);
        if (!requestId)
            throw new ApiError(400, "Task request ID is required.");
        const bids = await prisma.bid.findMany({
            where: { requestId },
            include: {
                worker_profile: {
                    include: {
                        user: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
        res.status(200).json({
            success: true,
            count: bids.length,
            bids,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Poster accepts a specific Bid
 * @route  POST /api/bids/:id/accept
 * @access Private (Poster)
 */
export const acceptBid = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const bidId = String(req.params.id);
        if (!bidId)
            throw new ApiError(400, "Bid ID is required.");
        const bid = await prisma.bid.findUnique({
            where: { id: bidId },
            include: {
                service_request: {
                    include: {
                        customer_profile: true,
                    },
                },
                worker_profile: {
                    include: { user: true },
                },
            },
        });
        if (!bid) {
            throw new ApiError(404, "Bid not found.");
        }
        if (bid.service_request.customer_profile.userId !== userId) {
            throw new ApiError(403, "Only the task poster can accept this bid.");
        }
        const completionOtp = Math.floor(1000 + Math.random() * 9000).toString();
        const result = await prisma.$transaction(async (tx) => {
            const updatedBid = await tx.bid.update({
                where: { id: bidId },
                data: { status: "accepted" },
            });
            await tx.bid.updateMany({
                where: {
                    requestId: bid.requestId,
                    id: { not: bidId },
                },
                data: { status: "rejected" },
            });
            await tx.service_request.update({
                where: { id: bid.requestId },
                data: { status: "assigned", budget: bid.proposedPrice },
            });
            const booking = await tx.booking.create({
                data: {
                    requestId: bid.requestId,
                    workerId: bid.workerId,
                    status: "pending",
                    otpCode: completionOtp,
                },
                include: {
                    service_request: true,
                    worker_profile: {
                        include: { user: { select: { id: true, name: true, phone: true } } },
                    },
                },
            });
            return { updatedBid, booking };
        }, { maxWait: 15000, timeout: 30000 });
        const workerUserId = bid.worker_profile.userId;
        const notification = await prisma.notification.create({
            data: {
                userId: workerUserId,
                title: "Bid Accepted! 🎉",
                message: `Your bid of ₹${bid.proposedPrice} on "${bid.service_request.title || "Task"}" was accepted. Awaiting poster escrow deposit.`,
                type: "bid_accepted",
                data: {
                    bookingId: result.booking.id,
                    taskId: bid.requestId,
                    amount: bid.proposedPrice,
                },
            },
        });
        emitNotificationToUser(workerUserId, notification);
        res.status(200).json({
            success: true,
            message: "Bid accepted. Please proceed to Escrow payment to unlock chat and start the task.",
            booking: result.booking,
            handshakeOtp: completionOtp,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Poster rejects a specific Bid
 * @route  POST /api/services/bids/:id/reject
 * @access Private (Poster)
 */
export const rejectBid = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const bidId = String(req.params.id);
        if (!bidId)
            throw new ApiError(400, "Bid ID is required.");
        const bid = await prisma.bid.findUnique({
            where: { id: bidId },
            include: {
                service_request: {
                    include: { customer_profile: true },
                },
                worker_profile: {
                    include: { user: true },
                },
            },
        });
        if (!bid) {
            throw new ApiError(404, "Bid not found.");
        }
        if (bid.service_request.customer_profile.userId !== userId) {
            throw new ApiError(403, "Only the task poster can reject this bid.");
        }
        const updatedBid = await prisma.bid.update({
            where: { id: bidId },
            data: { status: "rejected" },
        });
        const workerUserId = bid.worker_profile.userId;
        const taskTitle = bid.service_request.title || "Micro-Task";
        const notification = await prisma.notification.create({
            data: {
                userId: workerUserId,
                title: "Bid Update",
                message: `Your bid for task "${taskTitle}" was not accepted.`,
                type: "bid_rejected",
                data: {
                    taskId: bid.requestId,
                    bidId: bid.id,
                },
            },
        });
        emitNotificationToUser(workerUserId, notification);
        res.status(200).json({
            success: true,
            message: "Bid rejected. Worker has been notified.",
            bid: updatedBid,
        });
    }
    catch (error) {
        next(error);
    }
};
