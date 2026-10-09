import { prisma } from "../lib/prisma.js";
export const UserModel = {
    findAll: () => prisma.user.findMany(),
    findById: (id) => prisma.user.findUnique({ where: { id } }),
    findByEmail: (email) => prisma.user.findUnique({ where: { email } }),
    create: (data) => prisma.user.create({ data }),
    update: (id, data) => prisma.user.update({ where: { id }, data }),
};
