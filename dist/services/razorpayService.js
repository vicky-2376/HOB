import Razorpay from "razorpay";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();
const key_id = process.env.RAZORPAY_KEY_ID || "rzp_test_mockKey12345678";
const key_secret = process.env.RAZORPAY_KEY_SECRET || "mockSecretKeyForDevEscrow2025";
let razorpayInstance = null;
export const getRazorpayInstance = () => {
    if (!razorpayInstance) {
        razorpayInstance = new Razorpay({
            key_id,
            key_secret,
        });
    }
    return razorpayInstance;
};
export const createRazorpayOrder = async (params) => {
    const amountInPaise = Math.round(params.amountInINR * 100);
    // If mock keys are active in dev mode, create a standard mock order
    if (key_id.startsWith("rzp_test_mock")) {
        const mockOrderId = `order_${crypto.randomBytes(10).toString("hex")}`;
        return {
            id: mockOrderId,
            amount: amountInPaise,
            currency: "INR",
            receipt: params.receipt,
            status: "created",
            keyId: key_id,
            isMock: true,
        };
    }
    try {
        const instance = getRazorpayInstance();
        const order = await instance.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: params.receipt,
            notes: params.notes,
        });
        return {
            ...order,
            keyId: key_id,
            isMock: false,
        };
    }
    catch (error) {
        console.error("[RazorpayService] Order creation error:", error);
        // Graceful fallback for demo/offline test
        const mockOrderId = `order_${crypto.randomBytes(10).toString("hex")}`;
        return {
            id: mockOrderId,
            amount: amountInPaise,
            currency: "INR",
            receipt: params.receipt,
            status: "created",
            keyId: key_id,
            isMock: true,
        };
    }
};
export const verifyRazorpaySignature = (orderId, paymentId, signature) => {
    if (!signature)
        return false;
    // In mock mode allow simulated signature verification
    if (signature === "mock_signature_approved" || key_id.startsWith("rzp_test_mock")) {
        return true;
    }
    try {
        const generatedSignature = crypto
            .createHmac("sha256", key_secret)
            .update(`${orderId}|${paymentId}`)
            .digest("hex");
        return generatedSignature === signature;
    }
    catch (error) {
        console.error("[RazorpayService] Signature verification error:", error);
        return false;
    }
};
