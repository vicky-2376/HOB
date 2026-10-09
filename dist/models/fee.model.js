import { prisma } from "../lib/prisma.js";
export const FeeModel = {
    findByBookingId: (bookingId) => prisma.fee.findFirst({ where: { bookingId } }),
    create: (data) => prisma.fee.create({ data }),
};
