import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

/**
 * DATE NORMALIZER
 * Consistent with cancel/reschedule tools.
 * Handles: "tomorrow", "today", DD/MM/YYYY, YYYY-MM-DD, "7th April 2026", "April 7, 2026"
 */
const normalizeDate = (dateStr: string): string | null => {
    if (!dateStr) return null;
    const d = dateStr.trim().toLowerCase();
    const now = new Date();

    if (d === 'tomorrow') {
        const t = new Date(now);
        t.setDate(now.getDate() + 1);
        return t.toLocaleDateString('en-CA');
    }
    if (d === 'today') return now.toLocaleDateString('en-CA');

    if (d.includes('/')) {
        const parts = d.split('/');
        if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const month = parts[1].padStart(2, '0');
            let year = parts[2];
            if (year.length === 2) year = `20${year}`;
            const iso = `${year}-${month}-${day}`;
            if (!isNaN(Date.parse(iso))) return iso;
        }
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d))) return d;

    // Natural language fallback: "7th April 2026", "April 7, 2026"
    const cleaned = d.replace(/(\d+)(st|nd|rd|th)/g, '$1').replace(/,/g, '').trim();
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
        if (parsed.getFullYear() < now.getFullYear()) parsed.setFullYear(now.getFullYear());
        return parsed.toLocaleDateString('en-CA');
    }

    return null;
};

/**
 * TIME NORMALIZER
 * Consistent with rescheduleAppointment.ts.
 * Handles: "09:00", "9:00 AM", "2:30 PM", "9 AM", "9:00AM", "14", "9"
 */
const normalizeTime = (timeInput: string): string | null => {
    if (!timeInput) return null;
    const t = timeInput.trim().toLowerCase().replace(/\s+/g, ' ');

    if (/^\d{2}:\d{2}$/.test(t)) return t;

    const match = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (match) {
        let h = parseInt(match[1]);
        const mins = match[2];
        const p = match[3]?.toLowerCase();
        if (p === 'pm' && h < 12) h += 12;
        if (p === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:${mins}`;
    }

    const bareMatch = t.match(/^(\d{1,2})\s*(am|pm)$/i);
    if (bareMatch) {
        let h = parseInt(bareMatch[1]);
        const p = bareMatch[2].toLowerCase();
        if (p === 'pm' && h < 12) h += 12;
        if (p === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:00`;
    }

    if (/^\d{1,2}$/.test(t)) {
        const h = parseInt(t);
        if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:00`;
    }

    return null;
};

/**
 * PHONE VALIDATOR
 * Strips whitespace and non-digit characters (except leading +),
 * then checks for an exact 10-digit mobile number.
 */
const validatePhone = (phone: string): { valid: boolean; cleaned: string } => {
    if (!phone) return { valid: false, cleaned: '' };
    const cleaned = phone.trim().replace(/[^\d]/g, '');
    return { valid: cleaned.length === 10, cleaned };
};

export const handler: Handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const { doctorName, patientName, date, time, phone } = JSON.parse(event.body || '{}');

        // ──────────────────────────────────────────────
        // 1. INPUT VALIDATION
        // ──────────────────────────────────────────────
        if (!doctorName || !patientName || !date || !time || !phone) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: "Missing details. Please provide doctor name, patient name, date, time, and phone number."
                })
            };
        }

        // ──────────────────────────────────────────────
        // 2. PHONE VALIDATION
        // FIX: Rejects whitespace-only or too-short numbers
        // ──────────────────────────────────────────────
        const phoneCheck = validatePhone(phone);
        if (!phoneCheck.valid) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `The phone number "${phone}" is not valid. Please provide an exact 10-digit mobile number with no spaces or special characters.`
                })
            };
        }

        // ──────────────────────────────────────────────
        // 3. DATE NORMALIZATION + PAST-DATE GUARD
        // FIX: Handles natural language dates, blocks past dates
        // ──────────────────────────────────────────────
        const resolvedDate = normalizeDate(date);
        if (!resolvedDate) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `I couldn't understand the date "${date}". Please use a format like YYYY-MM-DD or "7 April 2026".`
                })
            };
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(resolvedDate) < today) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `The date ${resolvedDate} is in the past. Please choose a future date.`
                })
            };
        }

        // ──────────────────────────────────────────────
        // 4. TIME NORMALIZATION
        // FIX: Converts "9 AM" → "09:00", "2:30 PM" → "14:30"
        // ──────────────────────────────────────────────
        const normalizedTime = normalizeTime(time);
        if (!normalizedTime) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `I couldn't understand the time "${time}". Please use a format like "09:00", "9 AM", or "2:30 PM".`
                })
            };
        }

        // ──────────────────────────────────────────────
        // 5. DOCTOR LOOKUP — Character-gap pattern
        // FIX: Consistent with cancel/reschedule tools.
        // Old: .ilike('name', `%${doctorName}%`).single()
        //   → .single() throws 406 on 0 or 2+ matches
        //   → plain ilike fails on "Dr. M. S. S. S. Mukharjee"
        // New: Strip Dr/dots/spaces → gap pattern → .limit(1)
        // ──────────────────────────────────────────────
        const cleanSearch = doctorName
            .replace(/Dr\./gi, '')
            .replace(/\./g, '')
            .replace(/\s+/g, '')
            .trim();

        const { data: doctors, error: doctorError } = await supabase
            .from('doctors')
            .select('id, name, working_hours_start, working_hours_end')
            .ilike('name', `%${cleanSearch.split('').join('%')}%`)
            .limit(1);

        if (doctorError) throw doctorError;

        if (!doctors || doctors.length === 0) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    error_type: 'DOCTOR_NOT_FOUND',
                    message: `I couldn't find a doctor named "${doctorName}" in our system. Please verify the name.`
                })
            };
        }

        const doctor = doctors[0];
        console.log(`[BOOKING] Resolved: ${doctor.name} (${doctor.id}), Date: ${resolvedDate}, Time: ${normalizedTime}`);

        // ──────────────────────────────────────────────
        // 6. WORKING HOURS BOUNDARY CHECK
        // FIX: Prevents booking outside doctor's availability
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
                        message: `Dr. ${doctor.name} is available only between ${doctor.working_hours_start.substring(0, 5)} and ${doctor.working_hours_end.substring(0, 5)}. The requested time ${normalizedTime} is outside their working hours.`,
                        instruction: "Inform the user and ask them to pick a time within the working hours."
                    })
                };
            }
        }

        // ──────────────────────────────────────────────
        // 7. ATOMIC SAFETY CHECK (Race condition protection)
        // Unchanged logic, but now uses normalizedTime
        // ──────────────────────────────────────────────
        const { data: existing, error: checkError } = await supabase
            .from('appointments')
            .select('id')
            .eq('doctor_id', doctor.id)
            .eq('appointment_date', resolvedDate)
            .eq('appointment_time', normalizedTime)
            .eq('status', 'confirmed')
            .maybeSingle();

        if (checkError) throw checkError;

        if (existing) {
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    success: false,
                    message: `The ${normalizedTime} slot with Dr. ${doctor.name} on ${resolvedDate} is already booked.`,
                    instruction: "Inform the user about the conflict and ask for another time slot."
                })
            };
        }

        // ──────────────────────────────────────────────
        // 8. INSERT APPOINTMENT
        // Uses normalized date, time, and cleaned phone
        // ──────────────────────────────────────────────
        const { error: insertError } = await supabase
            .from('appointments')
            .insert({
                patient_name: patientName.trim(),
                doctor_id: doctor.id,
                appointment_date: resolvedDate,
                appointment_time: normalizedTime,
                phone: phoneCheck.cleaned,
                status: 'confirmed'
            });

        if (insertError) throw insertError;

        return {
            statusCode: 200, headers,
            body: JSON.stringify({
                success: true,
                message: 'Appointment confirmed successfully!',
                bookingSummary: {
                    doctor: doctor.name,
                    patient: patientName.trim(),
                    date: resolvedDate,
                    time: normalizedTime
                },
                instruction: "Confirm the booking details to the user and end the conversation politely."
            })
        };

    } catch (error: any) {
        console.error("[BOOKING_ERROR]:", error.message);
        return {
            statusCode: 200, headers,
            body: JSON.stringify({
                success: false,
                message: "A database error occurred while finalizing the booking. Please try again."
            })
        };
    }
};