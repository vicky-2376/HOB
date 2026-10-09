import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
let io = null;
export const initSocket = (httpServer) => {
    io = new SocketIOServer(httpServer, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
        },
    });
    // Socket Auth Middleware
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];
            if (!token) {
                return next(new Error("Authentication token required for Socket connection"));
            }
            const secret = process.env.JWT_SECRET || "super_secret_jwt_key_hyperlocal_2025";
            const decoded = jwt.verify(token, secret);
            const user = await prisma.user.findUnique({
                where: { id: decoded.id },
                select: { id: true, name: true, email: true },
            });
            if (!user) {
                return next(new Error("User not found"));
            }
            socket.user = user;
            next();
        }
        catch (error) {
            next(new Error("Invalid or expired authentication token"));
        }
    });
    io.on("connection", (socket) => {
        const user = socket.user;
        console.log(`[Socket] User connected: ${user.name} (${user.id})`);
        // Join user's private notification channel
        socket.join(`user:${user.id}`);
        // Join Booking Room (Chat)
        socket.on("join_booking", async (bookingId) => {
            try {
                if (!bookingId)
                    return;
                const booking = await prisma.booking.findUnique({
                    where: { id: bookingId },
                    include: {
                        service_request: {
                            include: { customer_profile: true },
                        },
                        worker_profile: true,
                    },
                });
                if (!booking) {
                    socket.emit("error", { message: "Booking not found" });
                    return;
                }
                const isCustomer = booking.service_request.customer_profile.userId === user.id;
                const isWorker = booking.worker_profile.userId === user.id;
                if (!isCustomer && !isWorker) {
                    socket.emit("error", { message: "Unauthorized to access this booking room" });
                    return;
                }
                // Check if Chat is Locked
                // Chat UNLOCKS ONLY when status is 'confirmed' or 'in_progress'
                const allowedStatuses = ["confirmed", "in_progress", "completed"];
                const isLocked = !allowedStatuses.includes(booking.status.toLowerCase());
                socket.join(`booking:${bookingId}`);
                socket.emit("booking_joined", {
                    bookingId,
                    status: booking.status,
                    isLocked,
                    message: isLocked
                        ? "Chat is strictly locked until Escrow payment is secured by the poster."
                        : "Chat unlocked. Secure end-to-end messaging active.",
                });
            }
            catch (err) {
                console.error("[Socket] join_booking error:", err);
            }
        });
        // Leave Booking Room
        socket.on("leave_booking", (bookingId) => {
            socket.leave(`booking:${bookingId}`);
        });
        // Send Real-Time Chat Message
        socket.on("send_message", async (data) => {
            try {
                const { bookingId, message } = data;
                if (!bookingId || !message || !message.trim())
                    return;
                const booking = await prisma.booking.findUnique({
                    where: { id: bookingId },
                    include: {
                        service_request: {
                            include: { customer_profile: true },
                        },
                        worker_profile: true,
                    },
                });
                if (!booking) {
                    socket.emit("error", { message: "Booking not found" });
                    return;
                }
                const isCustomer = booking.service_request.customer_profile.userId === user.id;
                const isWorker = booking.worker_profile.userId === user.id;
                if (!isCustomer && !isWorker) {
                    socket.emit("error", { message: "Unauthorized to send messages in this booking" });
                    return;
                }
                const allowedStatuses = ["confirmed", "in_progress", "completed"];
                if (!allowedStatuses.includes(booking.status.toLowerCase())) {
                    socket.emit("error", {
                        message: "Chat is strictly locked. Poster must accept bid and hold escrow payment first.",
                    });
                    return;
                }
                // Save message to Database
                const savedMessage = await prisma.chat_message.create({
                    data: {
                        bookingId,
                        senderId: user.id,
                        message: message.trim(),
                    },
                    include: {
                        sender: {
                            select: { id: true, name: true, avatarUrl: true },
                        },
                    },
                });
                // Broadcast to both participants in room
                io?.to(`booking:${bookingId}`).emit("new_message", savedMessage);
            }
            catch (err) {
                console.error("[Socket] send_message error:", err);
                socket.emit("error", { message: "Failed to send message" });
            }
        });
        socket.on("disconnect", () => {
            console.log(`[Socket] User disconnected: ${user.name}`);
        });
    });
    return io;
};
export const getIO = () => {
    return io;
};
/**
 * Helper to emit real-time skill matching notification to a user
 */
export const emitNotificationToUser = (userId, notification) => {
    if (io) {
        io.to(`user:${userId}`).emit("notification", notification);
    }
};
