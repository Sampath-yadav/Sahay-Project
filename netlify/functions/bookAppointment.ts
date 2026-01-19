import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'CORS preflight successful' }) };
  }

  try {
    const { doctorName, patientName, date, time, phone } = JSON.parse(event.body || '{}');
    
    if (!doctorName || !patientName || !date || !time || !phone) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required appointment details." }) };
    }

    // 1. Resolve Doctor ID from Name
    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id')
      .ilike('name', `%${doctorName}%`)
      .single();

    if (doctorError || !doctorData) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: `Could not find a doctor named ${doctorName}.` }) };
    }

    // 2. Safety check: Ensure the slot is still free (Double-booking protection)
    const { data: existing, error: checkError } = await supabase
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctorData.id)
      .eq('appointment_date', date)
      .eq('appointment_time', time)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (checkError) throw checkError;
    if (existing) {
      return { statusCode: 409, headers, body: JSON.stringify({ success: false, message: "Slot already taken." }) };
    }

    // 3. Insert the new appointment record
    const { error: appointmentError } = await supabase
      .from('appointments')
      .insert({ 
        patient_name: patientName, 
        doctor_id: doctorData.id, 
        appointment_date: date, 
        appointment_time: time, 
        phone: phone,
        status: 'confirmed'
      });

    if (appointmentError) throw appointmentError;
    
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Appointment booked successfully.' }) };
  } catch (error: any) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: error.message }) };
  }
};