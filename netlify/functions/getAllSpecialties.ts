import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

/**
 * RETRY LOGIC
 * ──────────────────────────────────────────────
 * FIX: Added exponential backoff retry (100ms, 200ms, 400ms).
 * Old: Single attempt — Supabase network blip → 500 error
 * New: 3 attempts with backoff before giving up.
 * Consistent with getAvailableSlots/getDoctorDetails.
 * ──────────────────────────────────────────────
 */
const queryWithRetry = async (query: any, maxAttempts = 3) => {
    const delays = [100, 200, 400];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const result = await query();
            if (result.error) throw result.error;
            return result;
        } catch (error: any) {
            if (attempt === maxAttempts - 1) throw error;
            console.log(`[SPECIALTIES_RETRY] Attempt ${attempt + 1}/${maxAttempts} failed. Retrying in ${delays[attempt]}ms...`);
            await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
    }
};

/**
 * FEATURE: Hospital Discovery Worker
 * Dynamically retrieves and deduplicates medical departments.
 */
export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (!supabase) {
        return {
            statusCode: 200, headers,
            body: JSON.stringify({ success: false, specialties: [], count: 0, message: "Database connection is not available." })
        };
    }

    try {
        // FIX: Wrapped in retry logic
        const { data } = await queryWithRetry(() =>
            supabase.from('doctors').select('specialty')
        );

        if (!data || data.length === 0) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    specialties: [],
                    count: 0,
                    message: "No specialties currently available in the database."
                })
            };
        }

        const rawSpecialties = data.map((doctor: { specialty: string }) => doctor.specialty);
        const uniqueSpecialties = [...new Set(rawSpecialties)].filter((s): s is string => !!s).sort();

        return {
            statusCode: 200, headers,
            body: JSON.stringify({
                specialties: uniqueSpecialties,
                count: uniqueSpecialties.length,
                lastUpdated: new Date().toISOString()
            })
        };

    } catch (error: any) {
        console.error("[SPECIALTIES_ERROR]:", error.message);
        // FIX: Always 200 so orchestrator can parse the response
        return {
            statusCode: 200, headers,
            body: JSON.stringify({
                success: false,
                specialties: [],
                count: 0,
                message: "Failed to retrieve the specialty list. Please try again."
            })
        };
    }
};