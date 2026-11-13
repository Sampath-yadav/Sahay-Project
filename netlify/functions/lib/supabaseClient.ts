// netlify/functions/lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';

// Backend functions use the SECRET key (bypasses RLS). Never expose it to the browser.
// Falls back to the legacy SUPABASE_SERVICE_ROLE_KEY name for older deployments.
const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';

if (!supabaseUrl || !supabaseKey) {
    console.error('[supabaseClient] Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variable.');
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
});
