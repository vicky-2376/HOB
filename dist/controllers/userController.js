import prisma from "../config/db.js";
import { ApiError } from "../middlewares/errorHandler.js";
/**
 * @desc   Get Current Logged-in User Full Profile View (/profile)
 * @route  GET /api/users/profile
 * @access Private
 */
export const getProfile = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                customer_profile: {
                    include: {
                        service_request: {
                            take: 5,
                            orderBy: { createdAt: "desc" },
                        },
                    },
                },
                worker_profile: {
                    include: {
                        booking: {
                            take: 5,
                            orderBy: { id: "desc" },
                            include: { review: true },
                        },
                    },
                },
            },
        });
        if (!user)
            throw new ApiError(404, "User not found");
        const earnedTransactions = await prisma.transaction.findMany({
            where: { payeeId: userId, payment: { status: "released" } },
        });
        const totalLifetimeEarnings = earnedTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);
        const activeHoldPayments = await prisma.payment.findMany({
            where: {
                status: "hold",
                booking: {
                    OR: [
                        { service_request: { customer_profile: { userId } } },
                        { worker_profile: { userId } },
                    ],
                },
            },
        });
        const escrowHold = activeHoldPayments.reduce((sum, p) => sum + p.amount, 0);
        const availableBalance = Math.max(0, totalLifetimeEarnings + 1000);
        let avgRating = 5.0;
        const workerProf = user.worker_profile[0];
        if (workerProf && workerProf.avgRating > 0) {
            avgRating = workerProf.avgRating;
        }
        else if (user.customer_profile && user.customer_profile.avgRating > 0) {
            avgRating = user.customer_profile.avgRating;
        }
        res.status(200).json({
            success: true,
            profile: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                age: user.age,
                skills: user.skills,
                role: user.role,
                avatarUrl: user.avatarUrl,
                avgRating,
                createdAt: user.createdAt,
                customerProfile: user.customer_profile,
                workerProfile: workerProf || null,
                wallet: {
                    availableBalance,
                    escrowHold,
                    totalLifetimeEarnings,
                },
            },
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Update Profile Details (Age, Address, Email, Name, Avatar, Skills)
 * @route  PUT /api/users/profile
 * @access Private
 */
export const updateProfile = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { name, email, age, skills, role, avatarUrl, address, latitude, longitude, hourlyRate, isAvailable, } = req.body;
        const updateUserData = {};
        if (name && name.trim())
            updateUserData.name = name.trim();
        if (email && email.trim())
            updateUserData.email = email.trim().toLowerCase();
        if (age !== undefined && !isNaN(Number(age)))
            updateUserData.age = Number(age);
        if (role && (role === "poster" || role === "worker"))
            updateUserData.role = role;
        if (avatarUrl !== undefined)
            updateUserData.avatarUrl = avatarUrl;
        const parsedSkills = Array.isArray(skills)
            ? skills
            : typeof skills === "string" && skills.trim()
                ? skills.split(",").map((s) => s.trim()).filter(Boolean)
                : [];
        if (parsedSkills.length > 0) {
            updateUserData.skills = parsedSkills;
        }
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateUserData,
        });
        if (address && address.trim()) {
            await prisma.customer_profile.upsert({
                where: { userId },
                update: {
                    address: address.trim(),
                    latitude: latitude !== undefined ? Number(latitude) : undefined,
                    longitude: longitude !== undefined ? Number(longitude) : undefined,
                },
                create: {
                    userId,
                    address: address.trim(),
                    latitude: latitude !== undefined ? Number(latitude) : undefined,
                    longitude: longitude !== undefined ? Number(longitude) : undefined,
                    avgRating: 5.0,
                },
            });
        }
        const workerProfile = await prisma.worker_profile.findFirst({
            where: { userId },
        });
        if (workerProfile) {
            await prisma.worker_profile.update({
                where: { id: workerProfile.id },
                data: {
                    ...(parsedSkills.length > 0
                        ? { skills: parsedSkills.join(", "), skillsList: parsedSkills }
                        : {}),
                    ...(hourlyRate !== undefined ? { hourlyRate: Number(hourlyRate) } : {}),
                    ...(isAvailable !== undefined ? { isAvailable: Boolean(isAvailable) } : {}),
                    ...(address ? { address: address.trim() } : {}),
                    ...(latitude !== undefined ? { latitude: Number(latitude) } : {}),
                    ...(longitude !== undefined ? { longitude: Number(longitude) } : {}),
                },
            });
        }
        else if (parsedSkills.length > 0 || hourlyRate) {
            await prisma.worker_profile.create({
                data: {
                    userId,
                    skills: parsedSkills.join(", "),
                    skillsList: parsedSkills,
                    hourlyRate: hourlyRate ? Number(hourlyRate) : 250,
                    isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : true,
                    address: address || "Indiranagar, Bengaluru",
                    avgRating: 5.0,
                },
            });
        }
        res.status(200).json({
            success: true,
            message: "Profile updated successfully.",
            user: updatedUser,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get In-App Notifications for User
 * @route  GET /api/users/notifications
 * @access Private
 */
export const getNotifications = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 30,
        });
        const unreadCount = await prisma.notification.count({
            where: { userId, isRead: false },
        });
        res.status(200).json({
            success: true,
            unreadCount,
            notifications,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Mark Notification as Read
 * @route  PATCH /api/users/notifications/:id/read
 * @access Private
 */
export const markNotificationRead = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const id = String(req.params.id);
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        await prisma.notification.updateMany({
            where: { id, userId },
            data: { isRead: true },
        });
        res.status(200).json({ success: true, message: "Marked as read." });
    }
    catch (error) {
        next(error);
    }
};
export const upsertCustomerProfile = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { address, latitude, longitude } = req.body;
        if (!address || typeof address !== "string" || !address.trim()) {
            throw new ApiError(400, "Address is required for Customer Profile.");
        }
        const customerProfile = await prisma.customer_profile.upsert({
            where: { userId },
            update: {
                address: address.trim(),
                latitude: latitude ? Number(latitude) : undefined,
                longitude: longitude ? Number(longitude) : undefined,
            },
            create: {
                userId,
                address: address.trim(),
                latitude: latitude ? Number(latitude) : undefined,
                longitude: longitude ? Number(longitude) : undefined,
                avgRating: 5.0,
            },
            include: {
                user: { select: { id: true, name: true, phone: true, email: true } },
            },
        });
        res.status(200).json({
            success: true,
            message: "Customer profile saved successfully.",
            profile: customerProfile,
        });
    }
    catch (error) {
        next(error);
    }
};
export const createWorkerProfile = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { skills, hourlyRate, isAvailable, address, latitude, longitude } = req.body;
        if (!skills || typeof skills !== "string" || !skills.trim()) {
            throw new ApiError(400, "Skills description/tags are required.");
        }
        const skillsList = skills.split(",").map((s) => s.trim()).filter(Boolean);
        const workerProfile = await prisma.worker_profile.create({
            data: {
                userId,
                skills: skills.trim(),
                skillsList,
                hourlyRate: Number(hourlyRate) || 250,
                isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : true,
                address: address || null,
                latitude: latitude ? Number(latitude) : null,
                longitude: longitude ? Number(longitude) : null,
                avgRating: 5.0,
            },
            include: {
                user: { select: { id: true, name: true, phone: true, email: true } },
            },
        });
        res.status(201).json({
            success: true,
            message: "Worker profile created successfully.",
            profile: workerProfile,
        });
    }
    catch (error) {
        next(error);
    }
};
export const updateWorkerProfile = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const id = String(req.params.id);
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        if (!id)
            throw new ApiError(400, "Worker profile ID is required.");
        const existingProfile = await prisma.worker_profile.findUnique({ where: { id } });
        if (!existingProfile || existingProfile.userId !== userId) {
            throw new ApiError(403, "Forbidden: You do not own this worker profile.");
        }
        const { skills, hourlyRate, isAvailable, address } = req.body;
        const skillsList = skills
            ? String(skills).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;
        const updatedProfile = await prisma.worker_profile.update({
            where: { id },
            data: {
                ...(skills !== undefined ? { skills: String(skills).trim(), skillsList } : {}),
                ...(hourlyRate !== undefined ? { hourlyRate: Number(hourlyRate) } : {}),
                ...(isAvailable !== undefined ? { isAvailable: Boolean(isAvailable) } : {}),
                ...(address !== undefined ? { address: String(address).trim() } : {}),
            },
        });
        res.status(200).json({
            success: true,
            message: "Worker profile updated successfully.",
            profile: updatedProfile,
        });
    }
    catch (error) {
        next(error);
    }
};
export const getMyProfiles = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                customer_profile: true,
                worker_profile: true,
            },
        });
        if (!user)
            throw new ApiError(404, "User not found.");
        res.status(200).json({
            success: true,
            data: {
                userId: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                age: user.age,
                skills: user.skills,
                customerProfile: user.customer_profile,
                workerProfiles: user.worker_profile,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
export const getAllWorkers = async (req, res, next) => {
    try {
        const { skill, availableOnly } = req.query;
        const where = {};
        if (availableOnly === "true")
            where.isAvailable = true;
        if (skill)
            where.skills = { contains: String(skill), mode: "insensitive" };
        const workers = await prisma.worker_profile.findMany({
            where,
            include: { user: { select: { id: true, name: true, phone: true } } },
            orderBy: { avgRating: "desc" },
        });
        res.status(200).json({ success: true, count: workers.length, workers });
    }
    catch (error) {
        next(error);
    }
};
export const getWorkerById = async (req, res, next) => {
    try {
        const id = String(req.params.id);
        const worker = await prisma.worker_profile.findUnique({
            where: { id },
            include: { user: { select: { id: true, name: true, phone: true } } },
        });
        if (!worker)
            throw new ApiError(404, "Worker not found");
        res.status(200).json({ success: true, worker });
    }
    catch (error) {
        next(error);
    }
};
