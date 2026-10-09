import { Router } from "express";
import { getProfile, updateProfile, getNotifications, markNotificationRead, upsertCustomerProfile, createWorkerProfile, updateWorkerProfile, getMyProfiles, getAllWorkers, getWorkerById, } from "../controllers/userController.js";
import { authenticateJWT } from "../middlewares/auth.js";
const router = Router();
// Public worker directory
router.get("/workers", getAllWorkers);
router.get("/workers/:id", getWorkerById);
// Authenticated user profile & notification routes
router.use(authenticateJWT);
router.get("/profile", getProfile);
router.put("/profile", updateProfile);
router.get("/notifications", getNotifications);
router.patch("/notifications/:id/read", markNotificationRead);
router.get("/my-profiles", getMyProfiles);
router.post("/customer-profile", upsertCustomerProfile);
router.post("/worker-profile", createWorkerProfile);
router.put("/worker-profile/:id", updateWorkerProfile);
export default router;
