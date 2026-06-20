// PCBPO Visa Operations Tracker — Supabase config
// The anon/public key below is SAFE to expose in client-side code.
// Data protection comes from Row Level Security (RLS) policies in
// Supabase, not from hiding this key — see sql/02_rls_policies.sql.

const SUPABASE_URL = "https://bdcolgeuktdoivgnkxbb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkY29sZ2V1a3Rkb2l2Z25reGJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzkxNjUsImV4cCI6MjA5NjU1NTE2NX0.a_bBttsfOAX-v0_a8Mf9tEmk5mXG6ESZXjYarhY8zNQ";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
