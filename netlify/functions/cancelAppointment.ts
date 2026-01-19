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
    const { doctorName, patientName, date } = JSON.parse(event.body || '{}');
    if (!doctorName || !patientName || !date) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing details for cancellation." }) };
    }

    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id')
      .ilike('name', `%${doctorName}%`)
      .single();

    if (doctorError || !doctorData) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: `Doctor ${doctorName} not found.` }) };
    }

    // Update status to 'cancelled' to preserve the record for the Admin Dashboard (Image-4)
    const { error } = await supabase
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('doctor_id', doctorData.id)
      .ilike('patient_name', `%${patientName}%`)
      .eq('appointment_date', date);

    if (error) throw error;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Appointment successfully cancelled.' }) };
  } catch (error: any) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: error.message }) };
  }
};