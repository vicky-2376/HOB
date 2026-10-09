import { prisma } from "../lib/prisma.js";
export const TransactionModel = {
    create: (data) => prisma.transaction.create({ data }),
    findByUser: (userId) => prisma.transaction.findMany({
        where: { OR: [{ payerId: userId }, { payeeId: userId }] },
    }),
};
