import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

/**
 * SMART DATE PARSER
 * Consistent with cancel/reschedule/bookAppointment tools.
 */
const smartDateParser = (dateInput: string): string | null => {
    if (!dateInput) return null;
    const input = dateInput.trim().toLowerCase();
    const now = new Date();

    if (input === 'tomorrow') {
        const tomorrow = new Date();
        tomorrow.setDate(now.getDate() + 1);
        return tomorrow.toLocaleDateString('en-CA');
    }
    if (input === 'today') return now.toLocaleDateString('en-CA');

    if (/^\d{1,2}$/.test(input)) {
        const date = new Date(now.getFullYear(), now.getMonth(), parseInt(input));
        return date.toLocaleDateString('en-CA');
    }

    if (input.includes('/')) {
        const parts = input.split('/');
        if (parts.length === 3) {
            let year = parts[2];
            if (year.length === 2) year = `20${year}`;
            return `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        if (parts.length === 2) {
            const date = new Date(now.getFullYear(), parseInt(parts[1]) - 1, parseInt(parts[0]));
            return date.toLocaleDateString('en-CA');
        }
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

    // Natural language fallback
    const cleaned = input
        .replace(/(\d+)(st|nd|rd|th)/g, '$1')
        .replace(/,/g, '')
        .trim();

    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
        if (parsed.getFullYear() < now.getFullYear()) {
            parsed.setFullYear(now.getFullYear());
        }
        return parsed.toLocaleDateString('en-CA');
    }

    return null;
};

/**
 * RETRY LOGIC FOR DATABASE STABILITY
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
            await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
    }
};

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        const { doctorName, date, timeOfDay } = JSON.parse(event.body || '{}');

        // Input validation
        if (!doctorName) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({ success: false, message: "Doctor name is required to check availability." })
            };
        }

        const resolvedDate = smartDateParser(date);
        if (!resolvedDate) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: date
                        ? `I couldn't understand the date "${date}". Please use a format like YYYY-MM-DD or "10 April 2026".`
                        : "A valid date is required to check availability."
                })
            };
        }

        // ──────────────────────────────────────────────
        // FIX: Past-date guard (defense-in-depth)
        // Even if the LLM sends a past date, the tool
        // returns a clear message instead of showing
        // empty slots or confusing the AI.
        // Same pattern as bookAppointment.ts.
        // ──────────────────────────────────────────────
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(resolvedDate) < today) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `The date ${resolvedDate} is in the past. Please ask the patient for a future date.`
                })
            };
        }

        // Character-gap doctor lookup
        const cleanSearch = doctorName
            .replace(/Dr\./gi, '')
            .replace(/\./g, '')
            .replace(/\s+/g, '')
            .trim();

        const searchPattern = `%${cleanSearch.split('').join('%')}%`;

        const { data: doctors } = await queryWithRetry(() =>
            supabase
                .from('doctors')
                .select('id, name, working_hours_start, working_hours_end')
                .ilike('name', searchPattern)
                .limit(1)
        );

        if (!doctors || doctors.length === 0) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `I couldn't find a doctor in our records matching "${doctorName}".`,
                    error_type: "DOCTOR_NOT_FOUND"
                })
            };
        }
        const doctor = doctors[0];

        // 3. SLOT GENERATION (unchanged)
        const slots: string[] = [];
        const [startH] = doctor.working_hours_start.split(':').map(Number);
        const [endH] = doctor.working_hours_end.split(':').map(Number);

        for (let h = startH; h < endH; h++) {
            slots.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`);
        }

        // 4. FETCH BOOKED APPOINTMENTS (unchanged)
        const { data: booked } = await queryWithRetry(() =>
            supabase
                .from('appointments')
                .select('appointment_time')
                .match({
                    doctor_id: doctor.id,
                    appointment_date: resolvedDate,
                    status: 'confirmed'
                })
        );

        const bookedTimes = (booked || []).map((b: any) => b.appointment_time.substring(0, 5));
        const available = slots.filter(s => !bookedTimes.includes(s));

        // 5. PERIOD CATEGORIZATION (unchanged)
        const morning = available.filter(t => parseInt(t.split(':')[0]) < 12);
        const afternoon = available.filter(t => {
            const h = parseInt(t.split(':')[0]);
            return h >= 12 && h < 17;
        });
        const evening = available.filter(t => parseInt(t.split(':')[0]) >= 17);

        // 6. CONVERSATIONAL RESPONSE (unchanged)
        if (!timeOfDay) {
            const summary = [];
            if (morning.length > 0) summary.push({ period: 'morning', count: morning.length });
            if (afternoon.length > 0) summary.push({ period: 'afternoon', count: afternoon.length });
            if (evening.length > 0) summary.push({ period: 'evening', count: evening.length });

            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: true,
                    doctorName: doctor.name,
                    date: resolvedDate,
                    periods: summary,
                    instruction: summary.length > 0
                        ? "Tell the user which periods have slots and ask for their preference."
                        : "No slots available. Suggest checking another date."
                })
            };
        } else {
            const target = timeOfDay.toLowerCase();
            const finalSlots = target === 'morning' ? morning : target === 'afternoon' ? afternoon : evening;

            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: true,
                    doctorName: doctor.name,
                    date: resolvedDate,
                    period: target,
                    slots: finalSlots,
                    instruction: `List the available ${target} times and ask the user to pick one.`
                })
            };
        }

    } catch (error: any) {
        console.error("[SLOTS_ERROR]:", error.message);
        return {
            statusCode: 200, headers,
            body: JSON.stringify({
                success: false,
                message: "I'm having trouble retrieving the schedule. Please try again."
            })
        };
    }
};