import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

/**
 * SMART DATE NORMALIZATION
 * ──────────────────────────────────────────────
 * FIX: Expanded to handle natural language dates that the LLM
 * might pass if it doesn't convert to ISO before calling.
 * 
 * Now handles:
 *   - "tomorrow"
 *   - "today"  
 *   - "2026-04-07"          (ISO — already worked)
 *   - "07/04/2026"          (DD/MM/YYYY — already worked)
 *   - "07/04/26"            (DD/MM/YY — already worked)
 *   - "7th April 2026"      (NEW — natural language)
 *   - "April 7, 2026"       (NEW — US format)
 *   - "7 April 2026"        (NEW — no ordinal)
 *   - "7th april"           (NEW — no year, assumes current year)
 * ──────────────────────────────────────────────
 */
const normalizeDate = (dateStr: string): { valid: boolean; date?: string; error?: string } => {
    if (!dateStr) return { valid: false, error: 'Date is required.' };

    let d = dateStr.trim().toLowerCase();
    const today = new Date();

    // Handle "tomorrow"
    if (d === 'tomorrow') {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return { valid: true, date: tomorrow.toLocaleDateString('en-CA') };
    }

    // Handle "today"
    if (d === 'today') {
        return { valid: true, date: today.toLocaleDateString('en-CA') };
    }

    // Handle DD/MM/YYYY or DD/MM/YY (existing logic, unchanged)
    if (d.includes('/')) {
        const parts = d.split('/');
        if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const month = parts[1].padStart(2, '0');
            let year = parts[2];
            if (year.length === 2) year = `20${year}`;
            const iso = `${year}-${month}-${day}`;
            if (!isNaN(Date.parse(iso))) return { valid: true, date: iso };
        }
    }

    // Handle YYYY-MM-DD (existing logic, unchanged)
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        if (!isNaN(Date.parse(d))) return { valid: true, date: d };
    }

    // ──────────────────────────────────────────────
    // NEW: Handle natural language dates
    // Covers: "7th April 2026", "7 April 2026", "April 7, 2026",
    //         "7th april", "april 7" (no year → current year)
    // 
    // Strategy: strip ordinal suffixes (st/nd/rd/th), then let
    // JavaScript's Date.parse() handle the rest. If it produces
    // a valid date, format it as YYYY-MM-DD.
    // ──────────────────────────────────────────────
    const cleaned = d
        .replace(/(\d+)(st|nd|rd|th)/g, '$1')  // "7th" → "7"
        .replace(/,/g, '')                       // "April 7, 2026" → "April 7 2026"
        .trim();

    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
        // Date.parse with no year defaults to 2001 on some engines.
        // If the parsed year is far in the past, assume current year.
        if (parsed.getFullYear() < today.getFullYear()) {
            parsed.setFullYear(today.getFullYear());
        }
        return { valid: true, date: parsed.toLocaleDateString('en-CA') };
    }

    return { valid: false, error: 'Could not understand the date. Please use a format like DD/MM/YYYY or "7 April 2026".' };
};

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        // Parse Request
        const { doctorName, patientName, date } = JSON.parse(event.body || '{}');
        console.log(`[CANCEL_ATTEMPT] Input: Dr='${doctorName}', Patient='${patientName}', Date='${date}'`);

        if (!doctorName || !patientName || !date) {
            return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Missing doctor name, patient name, or date." }) };
        }

        // 2. Normalize Date
        const dateCheck = normalizeDate(date);
        if (!dateCheck.valid) {
            return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: dateCheck.error }) };
        }

        /**
         * 3. SMART DOCTOR LOOKUP (Initials-Resilient)
         * We strip "Dr.", dots, and spaces to find a match regardless of how the user typed it.
         */
        const cleanSearch = doctorName
            .replace(/Dr\./gi, '')
            .replace(/\./g, '') // Remove dots
            .replace(/\s+/g, '') // Remove spaces
            .trim();

        // We search the 'name' column using a broad wildcard pattern
        const { data: doctors } = await supabase
            .from('doctors')
            .select('id, name')
            .ilike('name', `%${cleanSearch.split('').join('%')}%`) // Creates a pattern like %A%d%i%t%y%a%
            .limit(1);

        if (!doctors || doctors.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: false,
                    error_type: 'DOCTOR_NOT_FOUND',
                    message: `I couldn't find a doctor named '${doctorName}'. Please ensure the name is correct.`
                })
            };
        }

        const doctor = doctors[0];
        console.log(`[CANCEL_PROCESS] Resolved Doctor: ${doctor.name} (${doctor.id})`);

        /**
         * 4. APPOINTMENT CANCELLATION
         * We search for the specific confirmed appointment and update status to 'cancelled'.
         */
        const { data: updated, error: updateError } = await supabase
            .from('appointments')
            .update({ status: 'cancelled' })
            .match({
                doctor_id: doctor.id,
                appointment_date: dateCheck.date,
                status: 'confirmed'
            })
            .ilike('patient_name', `%${patientName.trim()}%`)
            .select();

        if (updateError) throw updateError;

        if (!updated || updated.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: false,
                    error_type: 'APPOINTMENT_NOT_FOUND',
                    message: `No confirmed appointment found for ${patientName} with Dr. ${doctor.name} on ${dateCheck.date}.`
                })
            };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: `Successfully cancelled the appointment for ${patientName} with Dr. ${doctor.name} on ${dateCheck.date}.`
            })
        };

    } catch (error: any) {
        console.error(`[CRITICAL_FAILURE]: ${error.message}`);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: false, message: "The cancellation service is temporarily unavailable." })
        };
    }
};