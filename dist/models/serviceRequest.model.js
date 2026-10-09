import { prisma } from "../lib/prisma.js";
export const ServiceRequestModel = {
    findById: (id) => prisma.service_request.findUnique({
        where: { id },
        include: { booking: true, service: true },
    }),
    findByCustomerId: (customerId) => prisma.service_request.findMany({ where: { customerId } }),
    create: (data) => prisma.service_request.create({ data: { ...data, status: "pending" } }),
    updateStatus: (id, status) => prisma.service_request.update({ where: { id }, data: { status } }),
};
