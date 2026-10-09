import { prisma } from "../lib/prisma.js";
export const CustomerProfileModel = {
    findByUserId: (userId) => prisma.customer_profile.findUnique({ where: { userId } }),
    create: (data) => prisma.customer_profile.create({ data }),
    update: (id, data) => prisma.customer_profile.update({ where: { id }, data }),
};
