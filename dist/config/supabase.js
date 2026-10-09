import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL || "https://oillamgncioszowcbomo.supabase.co";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pbGxhbWduY2lvc3pvd2Nib21vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NDI4MzcsImV4cCI6MjEwNDQxODgzN30.6N6X4sLwXo39PL5GGMP04ThmVr7rwZLp6fkINjzbwr8";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pbGxhbWduY2lvc3pvd2Nib21vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODg0MjgzNywiZXhwIjoyMTA0NDE4ODM3fQ.Z9dGZ8v8LVZYdbqZe_NGYbWno-z6fqbhr1aLJfJYOIE";
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});
export default supabase;
