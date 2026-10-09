import { prisma } from "../lib/prisma.js";
export const WorkerProfileModel = {
    findByUserId: (userId) => prisma.worker_profile.findFirst({ where: { userId } }),
    findAvailable: () => prisma.worker_profile.findMany({ where: { isAvailable: true } }),
    create: (data) => prisma.worker_profile.create({ data }),
    setAvailability: (id, isAvailable) => prisma.worker_profile.update({ where: { id }, data: { isAvailable } }),
};
