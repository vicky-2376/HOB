import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import prisma from "./config/db.js";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { initSocket } from "./socket/socketHandler.js";
dotenv.config();
const app = express();
const httpServer = http.createServer(app);
const PORT = Number(process.env.PORT) || 5000;
// Initialize WebSockets (Socket.io)
initSocket(httpServer);
// Security & Parsing Middlewares
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});
// Root & Health Endpoints
app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Hyperlocal P2P Micro-Tasking Platform API & Socket.io Gateway is running.",
        version: "1.0.0",
        theme: "Bumblebee",
        docs: "/health",
    });
});
app.get("/health", async (req, res) => {
    try {
        await prisma.$queryRaw `SELECT 1`;
        res.status(200).json({
            success: true,
            status: "healthy",
            database: "connected",
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        res.status(503).json({
            success: false,
            status: "degraded",
            database: "disconnected",
            timestamp: new Date().toISOString(),
        });
    }
});
// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/reviews", reviewRoutes);
// 404 and Global Error Handling
app.use(notFoundHandler);
app.use(errorHandler);
// Start HTTP + Socket.io Server
const server = httpServer.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🐝 Hyperlocal Micro-Task Server & Socket.io live on port ${PORT}`);
    console.log(`🐝 Base URL: http://localhost:${PORT}`);
    console.log(`🐝 Health Check: http://localhost:${PORT}/health`);
    console.log(`====================================================`);
});
// Graceful Shutdown
process.on("SIGINT", async () => {
    console.log("\nShutting down server gracefully...");
    await prisma.$disconnect();
    server.close(() => {
        console.log("Server closed. Process terminated.");
        process.exit(0);
    });
});
export default app;
