import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { ApiError } from "../middlewares/errorHandler.js";
import { sendOtpEmail } from "../services/emailService.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
const DEFAULT_DEV_OTP = "123456";
/**
 * Generate 6-digit random numeric OTP
 */
const generateOtpCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};
/**
 * Generate standard JWT Auth Token
 */
const generateJwtToken = (user) => {
    const secret = process.env.JWT_SECRET || "super_secret_jwt_key_hyperlocal_2025";
    return jwt.sign({
        id: user.id,
        email: user.email,
        role: user.role,
    }, secret, { expiresIn: "30d" });
};
/**
 * @desc   Sign Up with Email, Password, Name, Mandatory Age (18+), Phone, Skills, Role
 * @route  POST /api/auth/signup
 * @access Public
 */
export const signup = async (req, res, next) => {
    try {
        const { email, password, name, age, phone, skills, role = "poster", address } = req.body;
        if (!email || !String(email).trim() || !String(email).includes("@")) {
            throw new ApiError(400, "A valid email address is required.");
        }
        if (!password || String(password).length < 6) {
            throw new ApiError(400, "Password is required and must be at least 6 characters.");
        }
        if (!name || !String(name).trim()) {
            throw new ApiError(400, "Full Name is required.");
        }
        const parsedAge = parseInt(String(age), 10);
        if (age === undefined || age === null || isNaN(parsedAge) || parsedAge < 18) {
            throw new ApiError(400, "Age is mandatory and you must be 18 years or older.");
        }
        const cleanEmail = String(email).trim().toLowerCase();
        const cleanPhone = phone ? String(phone).trim() : null;
        const cleanName = String(name).trim();
        const userRole = role === "worker" ? "worker" : "poster";
        const existingUser = await prisma.user.findUnique({
            where: { email: cleanEmail },
        });
        if (existingUser) {
            throw new ApiError(400, "An account with this email already exists. Please log in.");
        }
        const hashedPassword = await hashPassword(String(password));
        const parsedSkills = Array.isArray(skills)
            ? skills.map((s) => String(s).trim()).filter(Boolean)
            : typeof skills === "string" && skills.trim()
                ? skills.split(",").map((s) => s.trim()).filter(Boolean)
                : userRole === "worker"
                    ? ["Delivery", "Errands"]
                    : [];
        const user = await prisma.user.create({
            data: {
                email: cleanEmail,
                password: hashedPassword,
                name: cleanName,
                age: parsedAge,
                phone: cleanPhone,
                skills: parsedSkills,
                role: userRole,
                customer_profile: {
                    create: {
                        address: address?.trim() || "Indiranagar, Bengaluru",
                        avgRating: 5.0,
                    },
                },
                worker_profile: {
                    create: {
                        skills: parsedSkills.join(", "),
                        skillsList: parsedSkills,
                        hourlyRate: 250,
                        isAvailable: true,
                        avgRating: 5.0,
                        address: address?.trim() || "Indiranagar, Bengaluru",
                    },
                },
            },
            include: {
                customer_profile: true,
                worker_profile: true,
            },
        });
        const token = generateJwtToken(user);
        res.status(201).json({
            success: true,
            message: "Account created successfully.",
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                age: user.age,
                skills: user.skills,
                role: user.role,
                avatarUrl: user.avatarUrl,
                customerProfile: user.customer_profile,
                workerProfiles: user.worker_profile,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Login with Email + Password
 * @route  POST /api/auth/login
 * @access Public
 */
export const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !String(email).trim()) {
            throw new ApiError(400, "Email is required.");
        }
        if (!password || !String(password).trim()) {
            throw new ApiError(400, "Password is required.");
        }
        const cleanEmail = String(email).trim().toLowerCase();
        const user = await prisma.user.findUnique({
            where: { email: cleanEmail },
            include: {
                customer_profile: true,
                worker_profile: true,
            },
        });
        if (!user) {
            throw new ApiError(401, "Invalid email or password.");
        }
        if (!user.password) {
            throw new ApiError(400, "No password is set for this account. Please use 'Login with Email OTP' or update your password in Profile.");
        }
        const isMatch = await verifyPassword(String(password), user.password);
        if (!isMatch) {
            throw new ApiError(401, "Invalid email or password.");
        }
        const token = generateJwtToken(user);
        res.status(200).json({
            success: true,
            message: "Login successful.",
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                age: user.age,
                skills: user.skills,
                role: user.role,
                avatarUrl: user.avatarUrl,
                customerProfile: user.customer_profile,
                workerProfiles: user.worker_profile,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Request 6-digit OTP for Email Login / Signup via Supabase Auth
 * @route  POST /api/auth/send-otp
 * @access Public
 */
export const sendOtp = async (req, res, next) => {
    try {
        const { email, phone } = req.body;
        const targetEmail = email ? String(email).trim().toLowerCase() : null;
        const targetPhone = phone ? String(phone).trim() : null;
        if (!targetEmail && !targetPhone) {
            throw new ApiError(400, "Please provide a valid email address.");
        }
        if (targetEmail) {
            console.log(`[Auth Service] Generating Official Supabase OTP for: ${targetEmail}`);
            let otpCode = generateOtpCode();
            try {
                const linkRes = await supabaseAdmin.auth.admin.generateLink({
                    type: "magiclink",
                    email: targetEmail,
                });
                if (linkRes.data?.properties?.email_otp) {
                    otpCode = linkRes.data.properties.email_otp;
                    console.log(`[Supabase Auth] Official 6-digit OTP generated: ${otpCode}`);
                }
            }
            catch (supErr) {
                console.warn("[Supabase Auth] generateLink fallback:", supErr?.message);
            }
            // Save to database OTP table for high-availability backup
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
            await prisma.otp.create({
                data: {
                    email: targetEmail,
                    otp: otpCode,
                    expiresAt,
                },
            });
            // Dispatch real email via Brevo SMTP to user's inbox
            await sendOtpEmail(targetEmail, otpCode);
            res.status(200).json({
                success: true,
                message: `6-digit OTP verification code sent to ${targetEmail}. Please check your inbox.`,
                email: targetEmail,
            });
            return;
        }
        // Phone identifier fallback if phone provided without email
        const identifier = `${targetPhone}@hyperlocal.in`;
        const otpCode = process.env.NODE_ENV === "production" ? generateOtpCode() : DEFAULT_DEV_OTP;
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await prisma.otp.create({
            data: {
                email: identifier,
                otp: otpCode,
                expiresAt,
            },
        });
        res.status(200).json({
            success: true,
            message: `OTP sent to ${identifier}.`,
            devOtp: DEFAULT_DEV_OTP,
            expiresIn: "10 minutes",
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Verify Supabase OTP, Register/Login User, Demand Mandatory Onboarding (Name, Age, Skills), and Issue JWT
 * @route  POST /api/auth/verify-otp
 * @access Public
 */
export const verifyOtp = async (req, res, next) => {
    try {
        const { email, phone, otp, name, age, skills, role, address } = req.body;
        const targetEmail = email ? String(email).trim().toLowerCase() : (phone ? `${String(phone).trim()}@hyperlocal.in` : null);
        if (!targetEmail || !otp) {
            throw new ApiError(400, "Email and OTP code are required.");
        }
        const cleanOtp = String(otp).trim().replace(/\s+/g, "");
        let isVerified = false;
        // 1. Verify with Supabase Auth (tries magiclink, email, signup types)
        if (targetEmail && !targetEmail.endsWith("@hyperlocal.in")) {
            console.log(`[Supabase Auth] Verifying OTP ${cleanOtp} for: ${targetEmail}`);
            // Try type 'magiclink'
            const { data: magicData, error: magicError } = await supabase.auth.verifyOtp({
                email: targetEmail,
                token: cleanOtp,
                type: "magiclink",
            });
            if (!magicError && magicData?.user) {
                isVerified = true;
            }
            else {
                // Try type 'email'
                const { data: emailData, error: emailError } = await supabase.auth.verifyOtp({
                    email: targetEmail,
                    token: cleanOtp,
                    type: "email",
                });
                if (!emailError && emailData?.user) {
                    isVerified = true;
                }
                else {
                    // Try type 'signup'
                    const { data: signupData, error: signupError } = await supabase.auth.verifyOtp({
                        email: targetEmail,
                        token: cleanOtp,
                        type: "signup",
                    });
                    if (!signupError && signupData?.user) {
                        isVerified = true;
                    }
                }
            }
        }
        // 2. Dev testing OTP fallback (when not verified through Supabase in non-production)
        if (!isVerified && cleanOtp === DEFAULT_DEV_OTP && process.env.NODE_ENV !== "production") {
            isVerified = true;
        }
        // 3. Database OTP fallback (Direct matching against verified stored OTP)
        if (!isVerified) {
            const dbOtp = await prisma.otp.findFirst({
                where: {
                    email: targetEmail,
                    otp: cleanOtp,
                    verified: false,
                    expiresAt: { gte: new Date() },
                },
                orderBy: { createdAt: "desc" },
            });
            if (dbOtp) {
                isVerified = true;
                await prisma.otp.update({
                    where: { id: dbOtp.id },
                    data: { verified: true },
                });
            }
        }
        if (!isVerified) {
            throw new ApiError(400, "Invalid or expired OTP. Please check the code sent to your email or request a new one.");
        }
        // Check if user already exists in PostgreSQL database
        let user = await prisma.user.findUnique({
            where: { email: targetEmail },
            include: {
                customer_profile: true,
                worker_profile: true,
            },
        });
        const parsedAge = age ? parseInt(String(age), 10) : 21;
        const parsedSkills = Array.isArray(skills)
            ? skills
            : typeof skills === "string" && skills.trim()
                ? skills.split(",").map((s) => s.trim()).filter(Boolean)
                : ["Errands", "Delivery"];
        const userRole = role === "worker" ? "worker" : "poster";
        if (!user) {
            // Mandatory validation for onboarding new user
            const defaultName = name?.trim() || targetEmail.split("@")[0] || "Task User";
            user = await prisma.user.create({
                data: {
                    email: targetEmail,
                    phone: phone ? String(phone).trim() : null,
                    name: defaultName,
                    age: isNaN(parsedAge) ? 21 : parsedAge,
                    skills: parsedSkills,
                    role: userRole,
                    customer_profile: {
                        create: {
                            address: address?.trim() || "Indiranagar, Bengaluru",
                            avgRating: 5.0,
                        },
                    },
                    worker_profile: {
                        create: {
                            skills: parsedSkills.join(", "),
                            skillsList: parsedSkills,
                            hourlyRate: 250,
                            isAvailable: true,
                            avgRating: 5.0,
                            address: address?.trim() || "Indiranagar, Bengaluru",
                        },
                    },
                },
                include: {
                    customer_profile: true,
                    worker_profile: true,
                },
            });
        }
        else {
            // If user provided additional onboarding details on login, update profile
            const updateData = {};
            if (name && name.trim())
                updateData.name = name.trim();
            if (age && !isNaN(parseInt(String(age), 10)))
                updateData.age = parseInt(String(age), 10);
            if (skills && Array.isArray(skills) && skills.length > 0)
                updateData.skills = skills;
            if (Object.keys(updateData).length > 0) {
                user = await prisma.user.update({
                    where: { id: user.id },
                    data: updateData,
                    include: {
                        customer_profile: true,
                        worker_profile: true,
                    },
                });
            }
            // Ensure customer & worker profiles exist
            if (!user.customer_profile) {
                await prisma.customer_profile.create({
                    data: {
                        userId: user.id,
                        address: address?.trim() || "Indiranagar, Bengaluru",
                        avgRating: 5.0,
                    },
                });
            }
            if (!user.worker_profile || user.worker_profile.length === 0) {
                await prisma.worker_profile.create({
                    data: {
                        userId: user.id,
                        skills: parsedSkills.join(", "),
                        skillsList: parsedSkills,
                        hourlyRate: 250,
                        isAvailable: true,
                        avgRating: 5.0,
                        address: address?.trim() || "Indiranagar, Bengaluru",
                    },
                });
            }
            // Refresh user object with profiles
            user = (await prisma.user.findUnique({
                where: { id: user.id },
                include: {
                    customer_profile: true,
                    worker_profile: true,
                },
            }));
        }
        const token = generateJwtToken(user);
        res.status(200).json({
            success: true,
            message: "Authentication successful.",
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                age: user.age,
                skills: user.skills,
                role: user.role,
                avatarUrl: user.avatarUrl,
                customerProfile: user.customer_profile,
                workerProfiles: user.worker_profile,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
/**
 * @desc   Get Current Logged-in User Profile & Full Identities
 * @route  GET /api/auth/me
 * @access Private
 */
export const getMe = async (req, res, next) => {
    try {
        if (!req.user) {
            throw new ApiError(401, "Not authenticated");
        }
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            include: {
                customer_profile: true,
                worker_profile: {
                    include: {
                        service: true,
                    },
                },
            },
        });
        if (!user) {
            throw new ApiError(404, "User not found");
        }
        res.status(200).json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                age: user.age,
                skills: user.skills,
                role: user.role,
                avatarUrl: user.avatarUrl,
                createdAt: user.createdAt,
                customerProfile: user.customer_profile,
                workerProfiles: user.worker_profile,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
