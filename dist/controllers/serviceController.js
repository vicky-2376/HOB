import prisma from "../config/db.js";
import { ApiError } from "../middlewares/errorHandler.js";
import { calculateHaversineDistanceKm } from "../utils/geo.js";
import { emitNotificationToUser } from "../socket/socketHandler.js";
/**
 * @desc   Create a Service Request (Post a Micro-Job Need with GPS Location & Time Constraints)
 * @route  POST /api/services/requests
 * @access Private (Poster / Customer)
 */
export const createServiceRequest = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized: Please login to post a task.");
        const { title, category = "Delivery", description = "", budget = 400, address, latitude, longitude, timeConstraint, scheduledFor, serviceId, } = req.body;
        if (!title || !title.trim()) {
            throw new ApiError(400, "Task title / summary is required.");
        }
        if (!address || !address.trim()) {
            throw new ApiError(400, "Pickup / task location address is required.");
        }
        const scheduledDate = scheduledFor ? new Date(scheduledFor) : new Date(Date.now() + 3600000);
        const parsedLat = latitude !== undefined && latitude !== null ? parseFloat(String(latitude)) : null;
        const parsedLon = longitude !== undefined && longitude !== null ? parseFloat(String(longitude)) : null;
        const numericBudget = parseFloat(String(budget)) || 350;
        let customerProfile = await prisma.customer_profile.findUnique({
            where: { userId },
        });
        if (!customerProfile) {
            customerProfile = await prisma.customer_profile.create({
                data: {
                    userId,
                    address: address.trim(),
                    latitude: parsedLat,
                    longitude: parsedLon,
                    avgRating: 5.0,
                },
            });
        }
        else if (parsedLat && parsedLon) {
            await prisma.customer_profile.update({
                where: { id: customerProfile.id },
                data: {
                    address: address.trim(),
                    latitude: parsedLat,
                    longitude: parsedLon,
                },
            });
        }
        const serviceRequest = await prisma.service_request.create({
            data: {
                customerId: customerProfile.id,
                serviceId: serviceId ? String(serviceId) : null,
                title: title.trim(),
                description: description?.trim() || null,
                category: category.trim(),
                budget: numericBudget,
                address: address.trim(),
                latitude: parsedLat,
                longitude: parsedLon,
                timeConstraint: timeConstraint?.trim() || "Within 3 hours",
                scheduledFor: scheduledDate,
                status: "pending",
            },
            include: {
                customer_profile: {
                    include: {
                        user: {
                            select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
                        },
                    },
                },
                bids: true,
            },
        });
        const cleanCategory = category.trim().toLowerCase();
        const matchingWorkers = await prisma.worker_profile.findMany({
            where: {
                userId: { not: userId },
                isAvailable: true,
                OR: [
                    { skills: { contains: cleanCategory, mode: "insensitive" } },
                    { skillsList: { has: category.trim() } },
                    { skills: { contains: "Errands", mode: "insensitive" } },
                ],
            },
            include: {
                user: { select: { id: true, name: true, email: true } },
            },
        });
        for (const worker of matchingWorkers) {
            const notification = await prisma.notification.create({
                data: {
                    userId: worker.userId,
                    title: `New ${category} Task Nearby!`,
                    message: `"${title.slice(0, 45)}..." offering ₹${numericBudget}. Place your bid now.`,
                    type: "task_match",
                    data: {
                        taskId: serviceRequest.id,
                        category,
                        budget: numericBudget,
                        address: serviceRequest.address,
                    },
                },
            });
            emitNotificationToUser(worker.userId, notification);
        }
        res.status(201).json({
            success: true,
            message: "Micro-task posted successfully and notified matching taskers.",
            request: serviceRequest,
            matchingWorkersNotified: matchingWorkers.length,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get All Service Requests (Browse Open Gigs / Feed with 5km Dynamic Radius)
 * @route  GET /api/services/requests/feed
 * @access Public / Private
 */
export const getAllServiceRequests = async (req, res, next) => {
    try {
        const currentUserId = req.user?.id;
        const { status = "pending", category, search, mode = "tasker", latitude, longitude, radius = "5", } = req.query;
        const parsedRadiusKm = parseFloat(String(radius)) || 5;
        const userLat = latitude ? parseFloat(String(latitude)) : null;
        const userLon = longitude ? parseFloat(String(longitude)) : null;
        let whereClause = {};
        if (status && status !== "all") {
            whereClause.status = String(status);
        }
        if (category && typeof category === "string" && category !== "All") {
            whereClause.category = {
                contains: category,
                mode: "insensitive",
            };
        }
        if (search && typeof search === "string" && search.trim()) {
            whereClause.OR = [
                { title: { contains: search.trim(), mode: "insensitive" } },
                { description: { contains: search.trim(), mode: "insensitive" } },
                { address: { contains: search.trim(), mode: "insensitive" } },
                { category: { contains: search.trim(), mode: "insensitive" } },
            ];
        }
        if (mode === "poster") {
            if (!currentUserId) {
                res.status(200).json({
                    success: true,
                    count: 0,
                    mode,
                    appliedRadiusKm: null,
                    requests: [],
                });
                return;
            }
            whereClause.customer_profile = {
                userId: currentUserId,
            };
        }
        else if (mode === "tasker" && currentUserId) {
            whereClause.customer_profile = {
                userId: { not: currentUserId },
            };
        }
        const rawRequests = await prisma.service_request.findMany({
            where: whereClause,
            include: {
                customer_profile: {
                    include: {
                        user: {
                            select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
                        },
                    },
                },
                bids: {
                    include: {
                        worker_profile: {
                            include: {
                                user: { select: { id: true, name: true, avatarUrl: true } },
                            },
                        },
                    },
                },
                booking: {
                    include: {
                        worker_profile: {
                            include: {
                                user: { select: { id: true, name: true, phone: true } },
                            },
                        },
                    },
                },
                service: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
        let processedRequests = rawRequests.map((r) => {
            let distanceKm = null;
            if (userLat !== null && userLon !== null && r.latitude !== null && r.longitude !== null) {
                distanceKm = calculateHaversineDistanceKm(userLat, userLon, r.latitude, r.longitude);
            }
            else if (r.latitude !== null && r.longitude !== null && userLat === null) {
                distanceKm = calculateHaversineDistanceKm(12.9716, 77.5946, r.latitude, r.longitude);
            }
            return {
                ...r,
                distanceKm,
                bidsCount: r.bids.length,
            };
        });
        if (mode === "tasker" && userLat !== null && userLon !== null) {
            processedRequests = processedRequests.filter((r) => {
                if (r.distanceKm === null)
                    return true;
                return r.distanceKm <= parsedRadiusKm;
            });
            processedRequests.sort((a, b) => {
                if (a.distanceKm === null)
                    return 1;
                if (b.distanceKm === null)
                    return -1;
                return (a.distanceKm ?? 0) - (b.distanceKm ?? 0);
            });
        }
        res.status(200).json({
            success: true,
            count: processedRequests.length,
            mode,
            appliedRadiusKm: mode === "tasker" ? parsedRadiusKm : null,
            requests: processedRequests,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get Specific Service Request Details
 * @route  GET /api/services/requests/:id
 * @access Public / Private
 */
export const getServiceRequestById = async (req, res, next) => {
    try {
        const id = String(req.params.id);
        if (!id)
            throw new ApiError(400, "Task ID is required.");
        const request = await prisma.service_request.findUnique({
            where: { id },
            include: {
                customer_profile: {
                    include: {
                        user: {
                            select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
                        },
                    },
                },
                bids: {
                    include: {
                        worker_profile: {
                            include: {
                                user: { select: { id: true, name: true, email: true, avatarUrl: true } },
                            },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
                booking: {
                    include: {
                        worker_profile: {
                            include: {
                                user: { select: { id: true, name: true, phone: true, avatarUrl: true } },
                            },
                        },
                        payment: true,
                        fee: true,
                        review: true,
                    },
                },
                service: true,
            },
        });
        if (!request) {
            throw new ApiError(404, "Service request not found.");
        }
        res.status(200).json({
            success: true,
            request,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get Service Requests Posted by Current Authenticated User (Poster Tasks)
 * @route  GET /api/services/requests/my
 * @access Private
 */
export const getMyServiceRequests = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const customerProfile = await prisma.customer_profile.findUnique({
            where: { userId },
        });
        if (!customerProfile) {
            res.status(200).json({
                success: true,
                count: 0,
                requests: [],
            });
            return;
        }
        const requests = await prisma.service_request.findMany({
            where: { customerId: customerProfile.id },
            include: {
                bids: {
                    include: {
                        worker_profile: {
                            include: {
                                user: { select: { id: true, name: true, avatarUrl: true } },
                            },
                        },
                    },
                },
                booking: {
                    include: {
                        worker_profile: {
                            include: {
                                user: { select: { id: true, name: true, phone: true } },
                            },
                        },
                        payment: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
        res.status(200).json({
            success: true,
            count: requests.length,
            requests,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * Legacy service catalog methods
 */
export const createService = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { title, category, baseRate, workerId } = req.body;
        let targetWorkerProfileId = workerId ? String(workerId) : undefined;
        if (!targetWorkerProfileId) {
            const workerProfile = await prisma.worker_profile.findFirst({
                where: { userId },
            });
            if (!workerProfile) {
                throw new ApiError(400, "Worker profile required.");
            }
            targetWorkerProfileId = workerProfile.id;
        }
        const service = await prisma.service.create({
            data: {
                workerId: targetWorkerProfileId,
                title: title.trim(),
                category: category.trim(),
                baseRate: Number(baseRate),
            },
            include: {
                worker_profile: true,
            },
        });
        res.status(201).json({ success: true, service });
    }
    catch (error) {
        next(error);
    }
};
export const getAllServices = async (req, res, next) => {
    try {
        const services = await prisma.service.findMany({
            include: { worker_profile: { include: { user: true } } },
        });
        res.status(200).json({ success: true, count: services.length, services });
    }
    catch (error) {
        next(error);
    }
};
export const getServiceById = async (req, res, next) => {
    try {
        const id = String(req.params.id);
        const service = await prisma.service.findUnique({
            where: { id },
            include: { worker_profile: { include: { user: true } } },
        });
        if (!service)
            throw new ApiError(404, "Service not found");
        res.status(200).json({ success: true, service });
    }
    catch (error) {
        next(error);
    }
};
