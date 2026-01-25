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
 * Handles: "tomorrow", "24", "24/01", "24/01/26", "2026-01-24"
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

  return null;
};

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { patientName, doctorName, oldDate, newDate, newTime } = body;

    const cleanDocName = doctorName.split(' ')[0].replace(/Dr\./gi, ''); 
    const { data: doctors } = await supabase
      .from('doctors')
      .select('id, name')
      .ilike('name', `%${cleanDocName}%`)
      .limit(1);

    if (!doctors || doctors.length === 0) {
      return { 
        statusCode: 200, headers, 
        body: JSON.stringify({ success: false, message: `Could not find a doctor matching '${doctorName}'.` }) 
      };
    }
    const doctor = doctors[0];

    const resolvedOldDate = smartDateParser(oldDate);
    const resolvedNewDate = smartDateParser(newDate);

    if (!resolvedOldDate) {
      return { 
        statusCode: 200, headers, 
        body: JSON.stringify({ success: false, message: `I couldn't verify the original date: ${oldDate}` }) 
      };
    }

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
          message: `I couldn't find a confirmed appointment for ${patientName} with Dr. ${doctor.name} on ${resolvedOldDate}.` 
        }) 
      };
    }

    if (resolvedNewDate && newTime && newTime.includes(':')) {
      const { data: conflict } = await supabase
        .from('appointments')
        .select('id')
        .match({ 
          doctor_id: doctor.id, 
          appointment_date: resolvedNewDate, 
          appointment_time: newTime,
          status: 'confirmed' 
        })
        .maybeSingle();

      if (conflict) {
        return { 
          statusCode: 200, headers, 
          body: JSON.stringify({ success: false, message: "Sorry, that new slot is already booked by another patient." }) 
        };
      }

      const { data: updated, error: updateError } = await supabase
        .from('appointments')
        .update({ 
          appointment_date: resolvedNewDate, 
          appointment_time: newTime,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingAppt.id)
        .select();

      if (updateError) throw updateError;

      // FIXED: Strictly checking the 'updated' variable to satisfy TS6133
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
          message: `Successfully rescheduled! Your appointment with Dr. ${doctor.name} is moved to ${resolvedNewDate} at ${newTime}.` 
        }) 
      };
    } else {
      return { 
        statusCode: 200, headers, 
        body: JSON.stringify({ 
          success: true, 
          needsNewSlot: true,
          message: `I found your record for ${resolvedOldDate}. What is the new date and time you would like to move this appointment to?` 
        }) 
      };
    }

  } catch (error: any) {
    console.error("[SMART_RESCHEDULE_ERROR]:", error.message);
    return { 
      statusCode: 200, headers, 
      body: JSON.stringify({ success: false, message: "I encountered a database error while rescheduling. Please try again later." }) 
    };
  }
};