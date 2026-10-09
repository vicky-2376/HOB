import crypto from "crypto";
/**
 * Hash password using crypto.scrypt with a unique random salt
 */
export const hashPassword = async (password) => {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err)
                return reject(err);
            resolve(`${salt}:${derivedKey.toString("hex")}`);
        });
    });
};
/**
 * Verify plaintext password against stored salt:hash string
 */
export const verifyPassword = async (password, storedHash) => {
    return new Promise((resolve, reject) => {
        const [salt, key] = storedHash.split(":");
        if (!salt || !key)
            return resolve(false);
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err)
                return reject(err);
            const keyBuffer = Buffer.from(key, "hex");
            const match = crypto.timingSafeEqual(keyBuffer, derivedKey);
            resolve(match);
        });
    });
};
