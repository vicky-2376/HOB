import { Router } from "express";
import { createService, getAllServices, getServiceById, createServiceRequest, getAllServiceRequests, getMyServiceRequests, getServiceRequestById, } from "../controllers/serviceController.js";
import { createBid, getBidsForTask, acceptBid, rejectBid } from "../controllers/bidController.js";
import { authenticateJWT } from "../middlewares/auth.js";
const router = Router();
// Service Catalog
router.post("/", authenticateJWT, createService);
router.get("/", getAllServices);
// Task Requests & Hyperlocal Feed
router.get("/requests/feed", (req, res, next) => {
    // Optional auth middleware attachment so authenticated users get tailored feeds
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        return authenticateJWT(req, res, next);
    }
    next();
}, getAllServiceRequests);
router.get("/requests/my", authenticateJWT, getMyServiceRequests);
router.post("/requests", authenticateJWT, createServiceRequest);
router.get("/requests/:id", getServiceRequestById);
// Bid & Apply Flow
router.post("/requests/:id/bids", authenticateJWT, createBid);
router.get("/requests/:id/bids", authenticateJWT, getBidsForTask);
router.post("/bids/:id/accept", authenticateJWT, acceptBid);
router.post("/bids/:id/reject", authenticateJWT, rejectBid);
router.get("/:id", getServiceById);
export default router;
