// PCBPO Visa Operations Tracker — Supabase config
// The anon/public key below is SAFE to expose in client-side code.
// Data protection comes from Row Level Security (RLS) policies in
// Supabase, not from hiding this key — see sql/02_rls_policies.sql.

const SUPABASE_URL = "https://kajzesphbfofokufiiza.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imthanplc3BoYmZvZm9rdWZpaXphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTI3MTUsImV4cCI6MjA5NjQ4ODcxNX0.eqUahwoHQ2XyUGCi4DqTuUCqwhIw1qduo0usDaL4ZJg";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
