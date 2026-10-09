import { prisma } from "../lib/prisma.js";
export const ServiceModel = {
    findAll: () => prisma.service.findMany(),
    findById: (id) => prisma.service.findUnique({ where: { id } }),
    findByWorkerId: (workerId) => prisma.service.findMany({ where: { workerId } }),
    create: (data) => prisma.service.create({ data }),
};
