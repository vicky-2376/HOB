import { prisma } from "../lib/prisma.js";
export const PaymentModel = {
    findByBookingId: (bookingId) => prisma.payment.findFirst({ where: { bookingId } }),
    create: (data) => prisma.payment.create({ data }),
    markCompleted: (id) => prisma.payment.update({ where: { id }, data: { status: "completed" } }),
};
