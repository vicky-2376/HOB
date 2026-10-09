import { prisma } from "../lib/prisma.js";
export const BookingModel = {
    findById: (id) => prisma.booking.findUnique({
        where: { id },
        include: { fee: true, payment: true, review: true },
    }),
    create: (data) => prisma.booking.create({ data }),
    updateStatus: (id, status) => prisma.booking.update({ where: { id }, data: { status } }),
    markStarted: (id) => prisma.booking.update({ where: { id }, data: { startedAt: new Date(), status: "in_progress" } }),
    markCompleted: (id) => prisma.booking.update({ where: { id }, data: { completedAt: new Date(), status: "completed" } }),
};
