import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * RETRY CONFIGURATION
 * Exponential backoff: 100ms, 200ms, 400ms (3 total attempts)
 */
const isTransientError = (error: any): boolean => {
  const msg = error?.message?.toLowerCase() || '';
  const code = error?.code || '';
  
  return (
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT'
  );
};

const queryWithRetry = async (query: any, maxAttempts = 3) => {
  const delays = [100, 200, 400];
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await query();
    } catch (error: any) {
      if (attempt === maxAttempts - 1 || !isTransientError(error)) {
        throw error;
      }
      
      const delayMs = delays[attempt];
      console.log(`[RETRY] Attempt ${attempt + 1}/${maxAttempts} failed. Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};

/**
 * CLEAN SEARCH STEM
 * Extracts the most reliable part of the name to bypass typos.
 */
const getStem = (term: string) => {
  if (!term) return '';
  // Remove "Dr.", special characters, and extra spaces
  const clean = term.replace(/Dr\./gi, '').replace(/[^a-zA-Z0-9 ]/g, '').trim();
  // Take first 4-5 characters to capture the root of the word
  return clean.length > 4 ? clean.substring(0, 5) : clean;
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // 1. DYNAMIC CONFIGURATION & SANITIZATION
    const rawUrl = process.env.SUPABASE_URL || '';
    const supabaseUrl = rawUrl.trim().replace(/\/$/, ""); // REMOVES TRAILING SLASH
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

    if (!supabaseUrl.startsWith('https')) {
      throw new Error("Missing or invalid SUPABASE_URL configuration.");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2. PARSE REQUEST
    const { specialty, doctorName } = JSON.parse(event.body || '{}');
    
    /**
     * SCHEMA ALIGNMENT:
     * id, name, specialty, working_hours_start, working_hours_end
     */
    const SELECT_FIELDS = 'id, name, specialty, working_hours_start, working_hours_end';

    console.log(`[SEARCH] Params: specialty=${specialty}, name=${doctorName}`);

    let query = supabase.from('doctors').select(SELECT_FIELDS);

    // 3. SMART PATTERN MATCHING (ILIKE)
    // We use the 'stem' of the word to find matches even with typos like "Cardiolagy" or "Aditya"
    if (specialty && doctorName) {
      const sStem = getStem(specialty);
      const nStem = getStem(doctorName);
      query = query.ilike('specialty', `%${sStem}%`).ilike('name', `%${nStem}%`);
    } else if (specialty) {
      const stem = getStem(specialty);
      query = query.ilike('specialty', `%${stem}%`);
    } else if (doctorName) {
      const stem = getStem(doctorName);
      query = query.ilike('name', `%${stem}%`);
    } else {
      query = query.limit(5); // Default list
    }

    // 4. EXECUTE (with retry)
    let data;
    let error;
    
    try {
      const result = await queryWithRetry(() => query);
      data = result.data;
      error = result.error;
    } catch (queryError: any) {
      error = queryError;
    }

    if (error) throw error;

    // 5. SECOND-TIER FALLBACK (Broad Search with Retry)
    // If the specific search fails, try an even broader search on the first 3 characters
    let finalData = data || [];
    if (finalData.length === 0 && (specialty || doctorName)) {
      const broadStem = (doctorName || specialty || "").trim().substring(0, 3);
      if (broadStem.length >= 2) {
        console.log(`[SEARCH] No results. Retrying with broad stem: ${broadStem}`);
        try {
          const result = await queryWithRetry(() =>
            supabase
              .from('doctors')
              .select(SELECT_FIELDS)
              .or(`name.ilike.%${broadStem}%,specialty.ilike.%${broadStem}%`)
              .limit(3)
          );
          finalData = result.data || [];
        } catch (fallbackError: any) {
          console.error('[SEARCH] Fallback search failed:', fallbackError.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        count: finalData.length,
        doctors: finalData,
        instruction: finalData.length > 0 
          ? "Found matches. Present the doctor's details warmly." 
          : "No matches found. Ask for the correct name or specialty."
      })
    };

  } catch (error: any) {
    console.error("[DOCTOR_SEARCH_CRITICAL]:", error.message);
    
    // Determine appropriate HTTP status based on error type
    let statusCode = 500;
    let errorType = "UNKNOWN_ERROR";
    
    if (isTransientError(error)) {
      statusCode = 503; // Service Unavailable
      errorType = "DATABASE_TEMPORARILY_UNAVAILABLE";
    } else if (error.message.includes('timeout')) {
      statusCode = 504; // Gateway Timeout
      errorType = "REQUEST_TIMEOUT";
    }
    
    // Return appropriate status but still include JSON so AI can handle it
    return {
      statusCode,
      headers,
      body: JSON.stringify({
        success: false,
        message: "I'm having a little trouble accessing our doctor directory right now. Could you please double-check the name?",
        error_type: errorType
      })
    };
  }
};