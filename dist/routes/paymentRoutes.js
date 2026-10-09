import { Router } from "express";
import { createRazorpayOrder, verifyRazorpayPayment, createWalletTopUpOrder, verifyWalletTopUp, requestWalletWithdrawal, payBookingWithWallet, releaseEscrowPayment, refundEscrowPayment, getPaymentByBooking, getMyTransactions, getWalletLedger, } from "../controllers/paymentController.js";
import { authenticateJWT } from "../middlewares/auth.js";
const router = Router();
router.use(authenticateJWT);
// Booking Escrow Payment (Razorpay)
router.post("/create-order", createRazorpayOrder);
router.post("/verify", verifyRazorpayPayment);
// Wallet Direct Top-Up (Razorpay)
router.post("/wallet/topup/create-order", createWalletTopUpOrder);
router.post("/wallet/topup/verify", verifyWalletTopUp);
// Wallet Withdrawal & Direct Booking Payment
router.post("/wallet/withdraw", requestWalletWithdrawal);
router.post("/wallet/pay-booking", payBookingWithWallet);
// Escrow Release & Refund
router.post("/release/:paymentId", releaseEscrowPayment);
router.post("/refund/:paymentId", refundEscrowPayment);
// Wallet Ledger & History
router.get("/wallet", getWalletLedger);
router.get("/transactions", getMyTransactions);
router.get("/booking/:bookingId", getPaymentByBooking);
export default router;
