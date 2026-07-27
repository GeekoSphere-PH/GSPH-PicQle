import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

// Lazy so importing this module never crashes an app/build that hasn't set
// Supabase env vars yet - the error only surfaces when a caller actually
// tries to use the client.
export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase environment variables are not set.');
  }

  client = createClient(supabaseUrl, supabaseAnonKey);
  return client;
}
