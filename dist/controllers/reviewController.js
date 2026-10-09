import prisma from "../config/db.js";
import { ApiError } from "../middlewares/errorHandler.js";
/**
 * @desc   Submit a Mutual Review & Rating for a Completed Booking
 * @route  POST /api/reviews
 * @access Private
 */
export const createReview = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new ApiError(401, "Unauthorized");
        const { bookingId, rating, comment } = req.body;
        if (!bookingId || rating === undefined) {
            throw new ApiError(400, "bookingId and rating (1-5) are required.");
        }
        const numericRating = Number(rating);
        if (isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
            throw new ApiError(400, "Rating must be a number between 1 and 5.");
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
        if (booking.status.toLowerCase() !== "completed") {
            throw new ApiError(400, "Reviews can only be submitted for COMPLETED tasks.");
        }
        const customerUserId = booking.service_request.customer_profile.userId;
        const workerUserId = booking.worker_profile.userId;
        if (userId !== customerUserId && userId !== workerUserId) {
            throw new ApiError(403, "You are not a participant in this booking.");
        }
        const isCustomerReviewing = userId === customerUserId;
        const revieweeId = isCustomerReviewing ? workerUserId : customerUserId;
        const existingReview = await prisma.review.findFirst({
            where: {
                bookingId: cleanBookingId,
                reviewerId: userId,
            },
        });
        if (existingReview) {
            throw new ApiError(400, "You have already submitted a review for this booking.");
        }
        const review = await prisma.review.create({
            data: {
                bookingId: cleanBookingId,
                reviewerId: userId,
                revieweeId,
                rating: numericRating,
                comment: comment ? String(comment).trim() : null,
            },
            include: {
                reviewer: { select: { id: true, name: true } },
                reviewee: { select: { id: true, name: true } },
            },
        });
        const allReviewsForReviewee = await prisma.review.findMany({
            where: { revieweeId },
            select: { rating: true },
        });
        const totalRatings = allReviewsForReviewee.length;
        const sumRatings = allReviewsForReviewee.reduce((acc, r) => acc + r.rating, 0);
        const newAvgRating = Number((sumRatings / totalRatings).toFixed(2));
        if (isCustomerReviewing) {
            await prisma.worker_profile.updateMany({
                where: { userId: revieweeId },
                data: { avgRating: newAvgRating },
            });
        }
        else {
            await prisma.customer_profile.updateMany({
                where: { userId: revieweeId },
                data: { avgRating: newAvgRating },
            });
        }
        res.status(201).json({
            success: true,
            message: "Review submitted successfully and average rating updated.",
            review,
            newAvgRating,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get All Reviews for a User
 * @route  GET /api/reviews/user/:userId
 * @access Public
 */
export const getReviewsForUser = async (req, res, next) => {
    try {
        const userId = String(req.params.userId);
        if (!userId)
            throw new ApiError(400, "User ID is required.");
        const reviews = await prisma.review.findMany({
            where: { revieweeId: userId },
            include: {
                reviewer: {
                    select: { id: true, name: true, phone: true },
                },
                booking: {
                    include: {
                        service_request: {
                            include: { service: true },
                        },
                    },
                },
            },
            orderBy: {
                id: "desc",
            },
        });
        res.status(200).json({
            success: true,
            count: reviews.length,
            reviews,
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get Mutual Reviews for a Booking
 * @route  GET /api/reviews/booking/:bookingId
 * @access Public / Private
 */
export const getReviewsForBooking = async (req, res, next) => {
    try {
        const bookingId = String(req.params.bookingId);
        if (!bookingId)
            throw new ApiError(400, "Booking ID is required.");
        const reviews = await prisma.review.findMany({
            where: { bookingId },
            include: {
                reviewer: { select: { id: true, name: true } },
                reviewee: { select: { id: true, name: true } },
            },
        });
        res.status(200).json({
            success: true,
            count: reviews.length,
            reviews,
        });
    }
    catch (error) {
        next(error);
    }
};
