import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  try {
    const { patientName, doctorName, oldDate, newDate, newTime } = JSON.parse(event.body || '{}');
    
    if (!patientName || !doctorName || !oldDate || !newDate || !newTime) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "Missing required details." }) };
    }

    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id')
      .ilike('name', `%${doctorName}%`)
      .single();

    if (doctorError || !doctorData) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: `Doctor ${doctorName} not found.` }) };
    }

    // Execute the reschedule update
    const { data: updatedData, error: updateError } = await supabase
      .from('appointments')
      .update({ appointment_date: newDate, appointment_time: newTime })
      .match({ 
        patient_name: patientName, 
        doctor_id: doctorData.id, 
        appointment_date: oldDate, 
        status: 'confirmed' 
      })
      .select();

    if (updateError) throw updateError;
    if (!updatedData || updatedData.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: "Could not find matching confirmed appointment." }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: `Successfully rescheduled to ${newDate} at ${newTime}.` }) };
  } catch (error: any) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: error.message }) };
  }
};