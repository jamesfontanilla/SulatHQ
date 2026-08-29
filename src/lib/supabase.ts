import { createClient } from "@supabase/supabase-js";

// These are intentionally public browser values. RLS protects the data; the
// privileged secret key remains server-only in the Cloudflare Worker.
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://iketybhztvmujhgdmriu.supabase.co";
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "sb_publishable_mbh-Ba_EYD1bf-WewKAqhA_Ha43hjyv";

export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

export function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured yet.");
  return supabase;
}
