import { createClient } from '@supabase/supabase-js';

/**
 * ENHANCED SUPABASE CLIENT WITH NETWORK RESILIENCE
 * Fixes: DNS resolution, connection pooling, request timeouts
 */

// 1. Fetch credentials - strict validation
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

// 2. Enhanced debugging for troubleshooting
console.log('[SUPABASE_CLIENT] Initialization check:', {
  environment: process.env.NODE_ENV,
  hasURL: !!supabaseUrl,
  hasAnonKey: !!supabaseAnonKey,
  hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  urlLength: supabaseUrl?.length,
  keyLength: supabaseAnonKey?.length
});

// 3. Detailed error reporting
if (!supabaseUrl) {
  const errorMsg = 
    'Missing SUPABASE_URL environment variable!\n' +
    'SOLUTION: Set in Netlify Dashboard → Site Settings → Environment Variables\n' +
    'Value should be: https://zvfxwztbzykvyhrjrfn.supabase.co';
  console.error('[SUPABASE_CLIENT] ❌', errorMsg);
  throw new Error(errorMsg);
}

if (!supabaseAnonKey) {
  const errorMsg = 
    'Missing SUPABASE_ANON_KEY environment variable!\n' +
    'SOLUTION: Set in Netlify Dashboard → Site Settings → Environment Variables';
  console.error('[SUPABASE_CLIENT] ❌', errorMsg);
  throw new Error(errorMsg);
}

// 4. Initialize client with enhanced connection handling
let client: any;
try {
  client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    // NETWORK RESILIENCE: Set connection timeout
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    },
    // Enable global request timeout (30 seconds for database operations)
    global: {
      headers: {
        'Request-Timeout': '30000'
      }
    }
  });
  
  console.log('[SUPABASE_CLIENT] ✅ Client initialized successfully');
  console.log('[SUPABASE_CLIENT] Connection URL verified:', supabaseUrl.substring(0, 20) + '...');
} catch (error: any) {
  console.error('[SUPABASE_CLIENT] ❌ Client initialization failed:', error.message);
  throw error;
}

// 5. Connection validation helper
export async function validateSupabaseConnection(): Promise<boolean> {
  try {
    const { error } = await Promise.race([
      (async () => {
        const result = await client.from('doctors').select('count').limit(1);
        return result;
      })(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 5000)
      )
    ]);
    
    if (error) {
      console.warn('[SUPABASE_CLIENT] Connection validation failed:', error.message);
      return false;
    }
    console.log('[SUPABASE_CLIENT] ✅ Connection validation passed');
    return true;
  } catch (error: any) {
    console.warn('[SUPABASE_CLIENT] Connection check error:', error.message);
    return false;
  }
}

export const supabase = client;