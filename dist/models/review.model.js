import { prisma } from "../lib/prisma.js";
export const ReviewModel = {
    create: (data) => prisma.review.create({ data }),
    findByRevieweeId: (revieweeId) => prisma.review.findMany({ where: { revieweeId } }),
};
