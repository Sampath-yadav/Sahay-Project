import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

/**
 * RETRY CONFIGURATION
 * Exponential backoff: 100ms, 200ms, 400ms (3 total attempts)
 * Preserved from original — proven stable in production.
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
 * CHARACTER-GAP DOCTOR SEARCH
 * ──────────────────────────────────────────────
 * FIX: Replaces stem-based search (first 5 chars).
 * Old: getStem("Dr. A. S. Mahesh") → "A" → matches any doctor
 * New: Strip Dr/dots/spaces → "ASMahesh" → %A%S%M%a%h%e%s%h%
 * Consistent with cancel/reschedule/bookAppointment tools.
 * ──────────────────────────────────────────────
 */
const buildSearchPattern = (term: string): string => {
    if (!term) return '%';
    const clean = term
        .replace(/Dr\./gi, '')
        .replace(/\./g, '')
        .replace(/\s+/g, '')
        .trim();
    if (!clean) return '%';
    return `%${clean.split('').join('%')}%`;
};

export const handler: Handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        const { specialty, doctorName } = JSON.parse(event.body || '{}');

        const SELECT_FIELDS = 'id, name, specialty, working_hours_start, working_hours_end';

        console.log(`[DOCTOR_SEARCH] Params: specialty=${specialty}, name=${doctorName}`);

        let query = supabase.from('doctors').select(SELECT_FIELDS);

        // ──────────────────────────────────────────────
        // FIX: Character-gap pattern for name search,
        // standard ilike for specialty (specialties are
        // clean single-word values, no initials issue).
        // ──────────────────────────────────────────────
        if (specialty && doctorName) {
            const namePattern = buildSearchPattern(doctorName);
            query = query
                .ilike('specialty', `%${specialty.trim()}%`)
                .ilike('name', namePattern);
        } else if (specialty) {
            query = query.ilike('specialty', `%${specialty.trim()}%`);
        } else if (doctorName) {
            const namePattern = buildSearchPattern(doctorName);
            query = query.ilike('name', namePattern);
        } else {
            query = query.limit(5);
        }

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

        // SECOND-TIER FALLBACK: Broader search if no results
        let finalData = data || [];
        if (finalData.length === 0 && (specialty || doctorName)) {
            const fallbackTerm = (doctorName || specialty || '').trim();
            const broadPattern = buildSearchPattern(fallbackTerm.substring(0, Math.min(fallbackTerm.length, 4)));

            if (fallbackTerm.length >= 2) {
                console.log(`[DOCTOR_SEARCH] No results. Retrying with broad pattern.`);
                try {
                    const result = await queryWithRetry(() =>
                        supabase
                            .from('doctors')
                            .select(SELECT_FIELDS)
                            .or(`name.ilike.${broadPattern},specialty.ilike.${broadPattern}`)
                            .limit(3)
                    );
                    finalData = result.data || [];
                } catch (fallbackError: any) {
                    console.error('[DOCTOR_SEARCH] Fallback failed:', fallbackError.message);
                }
            }
        }

        // ──────────────────────────────────────────────
        // FIX: Always return 200 so the orchestrator's
        // executeTool → response.json() never fails, and
        // Mistral always gets a parseable tool result.
        // Old: returned 503/504 for transient errors.
        // ──────────────────────────────────────────────
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

        // FIX: Always 200 — the error message tells the AI what happened
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: false,
                message: "I'm having a little trouble accessing our doctor directory right now. Could you please try again?",
                error_type: isTransientError(error) ? "DATABASE_TEMPORARILY_UNAVAILABLE" : "UNKNOWN_ERROR"
            })
        };
    }
};