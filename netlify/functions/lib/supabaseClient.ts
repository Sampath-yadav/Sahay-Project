import { createClient } from '@supabase/supabase-js';

// 1. Fetch credentials from your .env file
// These were the keys you copied from the Supabase API Settings
const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY as string;

// 2. Safety Check: Ensure the variables actually exist
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase Environment Variables');
}

// 3. Initialize the shared client
// This single 'supabase' object will be used by all other functions
export const supabase = createClient(supabaseUrl, supabaseAnonKey);