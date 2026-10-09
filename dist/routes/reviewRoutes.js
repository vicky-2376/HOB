import { Router } from "express";
import { createReview, getReviewsForUser, getReviewsForBooking, } from "../controllers/reviewController.js";
import { authenticateJWT } from "../middlewares/auth.js";
const router = Router();
router.post("/", authenticateJWT, createReview);
router.get("/user/:userId", getReviewsForUser);
router.get("/booking/:bookingId", getReviewsForBooking);
export default router;
