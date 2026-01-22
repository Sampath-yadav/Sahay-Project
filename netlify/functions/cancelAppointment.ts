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
 * Converts "23/01/26", "23/01/2026", "tomorrow", or ISO dates to YYYY-MM-DD
 */
const normalizeDate = (dateStr: string): { valid: boolean; date?: string; error?: string } => {
  if (!dateStr) return { valid: false, error: 'Date is required.' };
  
  let d = dateStr.trim().toLowerCase();
  const today = new Date();

  if (d === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return { valid: true, date: tomorrow.toLocaleDateString('en-CA') };
  }

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

  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    if (!isNaN(Date.parse(d))) return { valid: true, date: d };
  }

  return { valid: false, error: 'Please use DD/MM/YYYY format.' };
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