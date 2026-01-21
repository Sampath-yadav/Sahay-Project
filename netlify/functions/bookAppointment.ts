import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

// Standardized headers for CORS and JSON communication
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // 1. Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ message: 'CORS preflight successful' }) 
    };
  }

  try {
    const { doctorName, patientName, date, time, phone } = JSON.parse(event.body || '{}');
    
    // 2. Data Validation: Ensure all multi-step workflow details are present
    if (!doctorName || !patientName || !date || !time || !phone) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "Missing required appointment details." }) 
      };
    }

    // 3. Resolve Doctor ID: Map the AI-provided name to a UUID in Supabase
    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id')
      .ilike('name', `%${doctorName}%`)
      .single();

    if (doctorError || !doctorData) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Could not find a doctor named ${doctorName}.` 
        }) 
      };
    }

    /**
     * FEATURE INTEGRATION: ATOMIC SAFETY CHECK
     * We query specifically for an existing 'confirmed' slot. 
     * Using .maybeSingle() prevents errors if no row exists, returning null instead.
     */
    const { data: existing, error: checkError } = await supabase
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctorData.id)
      .eq('appointment_date', date)
      .eq('appointment_time', time)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (checkError) throw checkError;

    /**
     * FEATURE INTEGRATION: CONFLICT RESOLUTION (409) & EMPATHETIC MESSAGING
     * If 'existing' is true, it means someone else finalized their booking 
     * while the current user was still talking to the AI.
     */
    if (existing) {
      return { 
        statusCode: 409, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Sorry, the time slot ${time} with ${doctorName} was just booked by someone else. Please try another time.` 
        }) 
      };
    }

    // 4. Final Transaction: Insert the new appointment record
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
    
    // Success response for the AI Orchestrator
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        message: 'Appointment booked successfully.' 
      }) 
    };

  } catch (error: any) {
    console.error("CRITICAL_BOOKING_ERROR:", error.message);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ 
        success: false, 
        message: "A system error occurred while processing the booking." 
      }) 
    };
  }
};