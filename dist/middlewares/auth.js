import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { ApiError } from "./errorHandler.js";
export const authenticateJWT = async (req, res, next) => {
    try {
        const authHeader = req.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            throw new ApiError(401, "Access denied. No Bearer token provided.");
        }
        const token = authHeader.split(" ")[1];
        if (!token) {
            throw new ApiError(401, "Access denied. Malformed authorization header.");
        }
        const secret = process.env.JWT_SECRET || "super_secret_jwt_key_hyperlocal_2025";
        const decoded = jwt.verify(token, secret);
        const user = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: {
                id: true,
                email: true,
                name: true,
                age: true,
                phone: true,
                skills: true,
                role: true,
            },
        });
        if (!user) {
            throw new ApiError(401, "User belonging to this token no longer exists.");
        }
        req.user = user;
        next();
    }
    catch (error) {
        next(error);
    }
};
