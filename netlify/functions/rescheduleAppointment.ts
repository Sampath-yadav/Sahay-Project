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
 * ──────────────────────────────────────────────
 * FIX: Expanded to handle natural language dates.
 * Same pattern applied to cancelAppointment.ts.
 *
 * Handles:
 *   "tomorrow", "today"
 *   "24"                    (bare day number)
 *   "24/01", "24/01/26", "24/01/2026"  (slash formats)
 *   "2026-01-24"            (ISO)
 *   "10th April 2026"       (NEW — natural language with ordinal)
 *   "April 11, 2026"        (NEW — US format)
 *   "11 April"              (NEW — no year, assumes current year)
 * ──────────────────────────────────────────────
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
            const day = parts[0].padStart(2, '0');
            const month = parts[1].padStart(2, '0');
            let year = parts[2];
            if (year.length === 2) year = `20${year}`;
            const iso = `${year}-${month}-${day}`;
            return iso;
        }
        if (parts.length === 2) {
            const date = new Date(now.getFullYear(), parseInt(parts[1]) - 1, parseInt(parts[0]));
            return date.toLocaleDateString('en-CA');
        }
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

    // ──────────────────────────────────────────────
    // NEW: Handle natural language dates
    // "10th April 2026", "April 11, 2026", "11 April"
    // ──────────────────────────────────────────────
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
 * TIME NORMALIZER
 * ──────────────────────────────────────────────
 * NEW: Converts various time formats to HH:MM (24-hour).
 *
 * Handles:
 *   "09:00"        → "09:00"  (already correct)
 *   "9:00"         → "09:00"
 *   "9:00 AM"      → "09:00"
 *   "2:30 PM"      → "14:30"
 *   "9 AM"         → "09:00"
 *   "14:30"        → "14:30"
 *   "9"            → "09:00"  (bare hour)
 *   "9:00AM"       → "09:00"  (no space before AM)
 * ──────────────────────────────────────────────
 */
const normalizeTime = (timeInput: string): string | null => {
    if (!timeInput) return null;
    const t = timeInput.trim().toLowerCase().replace(/\s+/g, ' ');

    // Already HH:MM 24-hour format
    if (/^\d{2}:\d{2}$/.test(t)) return t;

    // H:MM or HH:MM with optional AM/PM
    const match = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (match) {
        let hours = parseInt(match[1]);
        const mins = match[2];
        const period = match[3]?.toLowerCase();

        if (period === 'pm' && hours < 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;

        return `${String(hours).padStart(2, '0')}:${mins}`;
    }

    // Bare hour with AM/PM: "9 AM", "2PM", "9am"
    const bareMatch = t.match(/^(\d{1,2})\s*(am|pm)$/i);
    if (bareMatch) {
        let hours = parseInt(bareMatch[1]);
        const period = bareMatch[2].toLowerCase();

        if (period === 'pm' && hours < 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;

        return `${String(hours).padStart(2, '0')}:00`;
    }

    // Bare hour only: "9" → "09:00", "14" → "14:00"
    if (/^\d{1,2}$/.test(t)) {
        const h = parseInt(t);
        if (h >= 0 && h <= 23) {
            return `${String(h).padStart(2, '0')}:00`;
        }
    }

    return null;
};

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        const body = JSON.parse(event.body || '{}');
        const { patientName, doctorName, oldDate, newDate, newTime } = body;

        console.log(`[RESCHEDULE_ATTEMPT] Input: Patient='${patientName}', Dr='${doctorName}', Old='${oldDate}', New='${newDate}', Time='${newTime}'`);

        // ──────────────────────────────────────────────
        // FIX: Input validation — check required fields upfront
        // ──────────────────────────────────────────────
        if (!patientName || !doctorName || !oldDate) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: "Missing required details. I need the patient name, doctor name, and original appointment date."
                })
            };
        }

        // ──────────────────────────────────────────────
        // FIX: Doctor lookup — character-gap pattern matching
        // (consistent with cancelAppointment.ts approach)
        //
        // Old: doctorName.split(' ')[0].replace(/Dr\./gi, '')
        //   → "Dr. A. S. Mahesh" became "A" — matched wrong doctors
        //
        // New: strips "Dr.", dots, spaces → "ASMahesh"
        //   → pattern %A%S%M%a%h%e%s%h% matches correctly
        // ──────────────────────────────────────────────
        const cleanSearch = doctorName
            .replace(/Dr\./gi, '')
            .replace(/\./g, '')
            .replace(/\s+/g, '')
            .trim();

        const { data: doctors } = await supabase
            .from('doctors')
            .select('id, name, working_hours_start, working_hours_end')
            .ilike('name', `%${cleanSearch.split('').join('%')}%`)
            .limit(1);

        if (!doctors || doctors.length === 0) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    error_type: 'DOCTOR_NOT_FOUND',
                    message: `Could not find a doctor matching '${doctorName}'. Please verify the name.`
                })
            };
        }
        const doctor = doctors[0];
        console.log(`[RESCHEDULE_PROCESS] Resolved Doctor: ${doctor.name} (${doctor.id})`);

        // Resolve dates
        const resolvedOldDate = smartDateParser(oldDate);
        const resolvedNewDate = smartDateParser(newDate);

        if (!resolvedOldDate) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `I couldn't understand the original date: "${oldDate}". Please use a format like DD/MM/YYYY or "10 April 2026".`
                })
            };
        }

        // Find the existing appointment
        const { data: existingAppt, error: findError } = await supabase
            .from('appointments')
            .select('id, patient_name, appointment_time')
            .match({
                doctor_id: doctor.id,
                appointment_date: resolvedOldDate,
                status: 'confirmed'
            })
            .ilike('patient_name', `%${patientName.trim()}%`)
            .maybeSingle();

        if (findError || !existingAppt) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    error_type: 'APPOINTMENT_NOT_FOUND',
                    message: `I couldn't find a confirmed appointment for ${patientName} with Dr. ${doctor.name} on ${resolvedOldDate}. Please check the details.`
                })
            };
        }

        // ──────────────────────────────────────────────
        // RESCHEDULE EXECUTION — when new date + time provided
        // ──────────────────────────────────────────────
        if (resolvedNewDate && newTime) {
            // FIX: Normalize the time input
            const normalizedTime = normalizeTime(newTime);

            if (!normalizedTime) {
                return {
                    statusCode: 200, headers,
                    body: JSON.stringify({
                        success: false,
                        message: `I couldn't understand the time "${newTime}". Please use a format like "09:00", "9 AM", or "2:30 PM".`
                    })
                };
            }

            // ──────────────────────────────────────────────
            // NEW: Working hours boundary check
            // Prevents rescheduling to slots outside the
            // doctor's availability window.
            // ──────────────────────────────────────────────
            if (doctor.working_hours_start && doctor.working_hours_end) {
                const startH = parseInt(doctor.working_hours_start.split(':')[0]);
                const endH = parseInt(doctor.working_hours_end.split(':')[0]);
                const requestedH = parseInt(normalizedTime.split(':')[0]);

                if (requestedH < startH || requestedH >= endH) {
                    return {
                        statusCode: 200, headers,
                        body: JSON.stringify({
                            success: false,
                            message: `Dr. ${doctor.name} is available only between ${doctor.working_hours_start.substring(0, 5)} and ${doctor.working_hours_end.substring(0, 5)}. The requested time ${normalizedTime} is outside their working hours.`
                        })
                    };
                }
            }

            // ──────────────────────────────────────────────
            // NEW: Prevent rescheduling to past dates
            // ──────────────────────────────────────────────
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const newDateObj = new Date(resolvedNewDate);
            if (newDateObj < today) {
                return {
                    statusCode: 200, headers,
                    body: JSON.stringify({
                        success: false,
                        message: `The new date ${resolvedNewDate} is in the past. Please choose a future date.`
                    })
                };
            }

            // ──────────────────────────────────────────────
            // NEW: Prevent rescheduling to the same slot
            // ──────────────────────────────────────────────
            if (resolvedNewDate === resolvedOldDate && normalizedTime === existingAppt.appointment_time.substring(0, 5)) {
                return {
                    statusCode: 200, headers,
                    body: JSON.stringify({
                        success: false,
                        message: `That is the same date and time as your current appointment. Please choose a different slot.`
                    })
                };
            }

            // Conflict check (existing logic, unchanged)
            const { data: conflict } = await supabase
                .from('appointments')
                .select('id')
                .match({
                    doctor_id: doctor.id,
                    appointment_date: resolvedNewDate,
                    appointment_time: normalizedTime,
                    status: 'confirmed'
                })
                .maybeSingle();

            if (conflict) {
                return {
                    statusCode: 200, headers,
                    body: JSON.stringify({
                        success: false,
                        message: `Sorry, the ${normalizedTime} slot with Dr. ${doctor.name} on ${resolvedNewDate} is already booked. Please choose another time.`
                    })
                };
            }

            // Execute the update (existing logic, uses normalizedTime)
            const { data: updated, error: updateError } = await supabase
                .from('appointments')
                .update({
                    appointment_date: resolvedNewDate,
                    appointment_time: normalizedTime,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existingAppt.id)
                .select();

            if (updateError) throw updateError;

            const hasUpdated = updated && updated.length > 0;
            if (!hasUpdated) {
                return {
                    statusCode: 200, headers,
                    body: JSON.stringify({ success: false, message: "The update could not be applied. Please try again." })
                };
            }

            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: true,
                    message: `Successfully rescheduled! Your appointment with Dr. ${doctor.name} is moved to ${resolvedNewDate} at ${normalizedTime}.`,
                    rescheduleSummary: {
                        doctor: doctor.name,
                        patient: existingAppt.patient_name,
                        oldDate: resolvedOldDate,
                        newDate: resolvedNewDate,
                        newTime: normalizedTime
                    }
                })
            };
        } else {
            // No new date/time provided yet — ask the user
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: true,
                    needsNewSlot: true,
                    message: `I found your appointment on ${resolvedOldDate} at ${existingAppt.appointment_time.substring(0, 5)} with Dr. ${doctor.name}. What is the new date and time you would like?`
                })
            };
        }

    } catch (error: any) {
        console.error("[RESCHEDULE_ERROR]:", error.message);
        return {
            statusCode: 200, headers,
            body: JSON.stringify({ success: false, message: "I encountered a database error while rescheduling. Please try again later." })
        };
    }
};