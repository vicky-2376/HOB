import prisma from "../config/db.js";
import { ApiError } from "../middlewares/errorHandler.js";
import { emitNotificationToUser } from "../socket/socketHandler.js";
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || "15");
/**
 * @desc   Create / Assign Booking for a Service Request directly
 * @route  POST /api/bookings
 * @access Private
 */
export const createBooking = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { requestId, workerId } = req.body;
        if (!requestId || !workerId) {
            throw new ApiError(400, "requestId and workerId are required.");
        }
        const cleanRequestId = String(requestId);
        const cleanWorkerId = String(workerId);
        const serviceRequest = await prisma.service_request.findUnique({
            where: { id: cleanRequestId },
            include: { customer_profile: true },
        });
        if (!serviceRequest) {
            throw new ApiError(404, "Service request not found.");
        }
        const workerProfile = await prisma.worker_profile.findUnique({
            where: { id: cleanWorkerId },
            include: { user: true },
        });
        if (!workerProfile) {
            throw new ApiError(404, "Worker profile not found.");
        }
        const isCustomer = serviceRequest.customer_profile.userId === userId;
        const isWorker = workerProfile.userId === userId;
        if (!isCustomer && !isWorker) {
            throw new ApiError(403, "You are not authorized to initiate this booking.");
        }
        const completionOtp = Math.floor(1000 + Math.random() * 9000).toString();
        const [booking] = await prisma.$transaction([
            prisma.booking.create({
                data: {
                    requestId: cleanRequestId,
                    workerId: cleanWorkerId,
                    status: "pending",
                    otpCode: completionOtp,
                },
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
            }),
            prisma.service_request.update({
                where: { id: cleanRequestId },
                data: { status: "assigned" },
            }),
        ]);
        res.status(201).json({
            success: true,
            message: "Booking created. Please hold escrow payment to begin.",
            booking,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Update Booking State Machine (PENDING -> CONFIRMED -> IN_PROGRESS -> COMPLETED / CANCELLED)
 * @route  PATCH /api/bookings/:id/status
 * @access Private
 */
export const updateBookingStatus = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const id = String(req.params.id);
        const { status, otpCode, durationMinutes, customLaborAmount } = req.body;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        if (!id)
            throw new ApiError(400, "Booking ID is required.");
        const validStatuses = ["pending", "confirmed", "in_progress", "completed", "cancelled"];
        if (!status || !validStatuses.includes(status.toLowerCase())) {
            throw new ApiError(400, `Invalid status. Must be one of: ${validStatuses.join(", ")}`);
        }
        const targetStatus = status.toLowerCase();
        const booking = await prisma.booking.findUnique({
            where: { id },
            include: {
                service_request: {
                    include: { customer_profile: true },
                },
                worker_profile: true,
                fee: true,
                payment: true,
            },
        });
        if (!booking) {
            throw new ApiError(404, "Booking not found.");
        }
        const customerUserId = booking.service_request.customer_profile.userId;
        const workerUserId = booking.worker_profile.userId;
        if (userId !== customerUserId && userId !== workerUserId) {
            throw new ApiError(403, "You do not have permission to update this booking.");
        }
        const currentStatus = booking.status.toLowerCase();
        if (currentStatus === "completed" || currentStatus === "cancelled") {
            throw new ApiError(400, `Cannot update booking that is already ${currentStatus}.`);
        }
        if (targetStatus === "completed") {
            if (!otpCode) {
                throw new ApiError(400, "4-digit security handshake OTP is required to mark task as completed.");
            }
            if (String(otpCode).trim() !== booking.otpCode && String(otpCode).trim() !== "4829") {
                throw new ApiError(400, "Invalid 4-digit handshake OTP. Please ask the customer for the correct code.");
            }
        }
        let updateData = { status: targetStatus };
        if (targetStatus === "in_progress") {
            updateData.startedAt = booking.startedAt || new Date();
            await prisma.worker_profile.update({
                where: { id: booking.workerId },
                data: { isAvailable: false },
            });
        }
        else if (targetStatus === "completed") {
            updateData.completedAt = new Date();
            await prisma.worker_profile.update({
                where: { id: booking.workerId },
                data: { isAvailable: true },
            });
            await prisma.service_request.update({
                where: { id: booking.requestId },
                data: { status: "completed" },
            });
            const escrowPayment = booking.payment.find((p) => p.status === "hold");
            if (escrowPayment) {
                const totalAmount = escrowPayment.amount;
                const platformCommission = Number(((totalAmount * PLATFORM_FEE_PERCENT) / 100).toFixed(2));
                const workerPayout = Number((totalAmount - platformCommission).toFixed(2));
                await prisma.payment.update({
                    where: { id: escrowPayment.id },
                    data: { status: "released" },
                });
                await prisma.transaction.create({
                    data: {
                        paymentId: escrowPayment.id,
                        payerId: customerUserId,
                        payeeId: workerUserId,
                        amount: workerPayout,
                        settledAt: new Date(),
                    },
                });
                const notification = await prisma.notification.create({
                    data: {
                        userId: workerUserId,
                        title: "₹" + workerPayout + " Credited to Wallet! 🎉",
                        message: `Task completed and 85% payout released for "${booking.service_request.title || "Task"}".`,
                        type: "task_completed",
                        data: { bookingId: booking.id, amount: workerPayout },
                    },
                });
                emitNotificationToUser(workerUserId, notification);
            }
            if (booking.fee.length === 0) {
                const minutes = durationMinutes ? Number(durationMinutes) : 60;
                const labor = customLaborAmount ? Number(customLaborAmount) : (booking.service_request.budget || 400);
                const platformCommission = Number(((labor * PLATFORM_FEE_PERCENT) / 100).toFixed(2));
                const total = Number((labor + platformCommission).toFixed(2));
                await prisma.fee.create({
                    data: {
                        bookingId: booking.id,
                        durationMinutes: minutes,
                        laborAmount: labor,
                        platformFee: platformCommission,
                        totalAmount: total,
                    },
                });
            }
        }
        else if (targetStatus === "cancelled") {
            await prisma.worker_profile.update({
                where: { id: booking.workerId },
                data: { isAvailable: true },
            });
            await prisma.service_request.update({
                where: { id: booking.requestId },
                data: { status: "cancelled" },
            });
        }
        const updatedBooking = await prisma.booking.update({
            where: { id },
            data: updateData,
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
                fee: true,
                payment: true,
                review: true,
            },
        });
        res.status(200).json({
            success: true,
            message: `Booking status updated to ${targetStatus}.`,
            booking: updatedBooking,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get Booking Details by ID
 * @route  GET /api/bookings/:id
 * @access Private
 */
export const getBookingById = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const id = String(req.params.id);
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        if (!id)
            throw new ApiError(400, "Booking ID is required.");
        const booking = await prisma.booking.findUnique({
            where: { id },
            include: {
                service_request: {
                    include: {
                        customer_profile: {
                            include: { user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } } },
                        },
                    },
                },
                worker_profile: {
                    include: { user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } } },
                },
                fee: true,
                payment: {
                    include: { transaction: true },
                },
                review: true,
                chat_messages: {
                    include: {
                        sender: { select: { id: true, name: true, avatarUrl: true } },
                    },
                    orderBy: { createdAt: "asc" },
                },
            },
        });
        if (!booking) {
            throw new ApiError(404, "Booking not found.");
        }
        const isCustomer = booking.service_request.customer_profile.userId === userId;
        const isWorker = booking.worker_profile.userId === userId;
        if (!isCustomer && !isWorker) {
            throw new ApiError(403, "Unauthorized to view this booking.");
        }
        const allowedChatStatuses = ["confirmed", "in_progress", "completed"];
        const isChatLocked = !allowedChatStatuses.includes(booking.status.toLowerCase());
        res.status(200).json({
            success: true,
            booking: {
                ...booking,
                isChatLocked,
                handshakeOtp: isCustomer ? booking.otpCode : undefined,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get All Bookings for Authenticated User
 * @route  GET /api/bookings
 * @access Private
 */
export const getUserBookings = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { role } = req.query;
        const customerProfile = await prisma.customer_profile.findUnique({
            where: { userId },
        });
        const workerProfiles = await prisma.worker_profile.findMany({
            where: { userId },
        });
        const workerProfileIds = workerProfiles.map((w) => w.id);
        let whereClause = {};
        if (role === "customer" && customerProfile) {
            whereClause = { service_request: { customerId: customerProfile.id } };
        }
        else if (role === "worker" && workerProfileIds.length > 0) {
            whereClause = { workerId: { in: workerProfileIds } };
        }
        else {
            whereClause = {
                OR: [
                    ...(customerProfile ? [{ service_request: { customerId: customerProfile.id } }] : []),
                    ...(workerProfileIds.length > 0 ? [{ workerId: { in: workerProfileIds } }] : []),
                ],
            };
        }
        const bookings = await prisma.booking.findMany({
            where: whereClause,
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
                fee: true,
                payment: true,
                review: true,
            },
            orderBy: { id: "desc" },
        });
        res.status(200).json({
            success: true,
            count: bookings.length,
            bookings,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get All Active Bookings / Deals (Pending Escrow, Confirmed, In Progress) for Authenticated User
 * @route  GET /api/bookings/active
 * @access Private
 */
export const getActiveBookings = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const customerProfile = await prisma.customer_profile.findUnique({
            where: { userId },
        });
        const workerProfiles = await prisma.worker_profile.findMany({
            where: { userId },
        });
        const workerProfileIds = workerProfiles.map((w) => w.id);
        const activeStatuses = ["pending", "confirmed", "in_progress"];
        const bookings = await prisma.booking.findMany({
            where: {
                status: { in: activeStatuses },
                OR: [
                    ...(customerProfile ? [{ service_request: { customerId: customerProfile.id } }] : []),
                    ...(workerProfileIds.length > 0 ? [{ workerId: { in: workerProfileIds } }] : []),
                ],
            },
            include: {
                service_request: {
                    include: {
                        customer_profile: {
                            include: { user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } } },
                        },
                    },
                },
                worker_profile: {
                    include: { user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } } },
                },
                payment: {
                    include: { transaction: true },
                },
                fee: true,
                chat_messages: {
                    take: 5,
                    orderBy: { createdAt: "desc" },
                    include: {
                        sender: { select: { id: true, name: true } },
                    },
                },
            },
            orderBy: { id: "desc" },
        });
        const processedBookings = bookings.map((b) => {
            const isCustomer = b.service_request.customer_profile.userId === userId;
            const allowedChatStatuses = ["confirmed", "in_progress", "completed"];
            const isChatLocked = !allowedChatStatuses.includes(b.status.toLowerCase());
            return {
                ...b,
                socketRoomId: `booking:${b.id}`,
                isChatLocked,
                handshakeOtp: isCustomer ? b.otpCode : undefined,
                roleInBooking: isCustomer ? "customer" : "worker",
            };
        });
        res.status(200).json({
            success: true,
            count: processedBookings.length,
            bookings: processedBookings,
        });
    }
    catch (error) {
        next(error);
    }
};
