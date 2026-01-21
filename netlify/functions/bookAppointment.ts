import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

/**
 * Standardized headers to handle CORS and JSON communication.
 * Allows the React frontend and the AI Orchestrator to communicate securely.
 */
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
    // Parse the payload sent by the getAiResponse orchestrator
    const { doctorName, patientName, date, time, phone } = JSON.parse(event.body || '{}');
    
    // 2. Data Validation
    // Validates that all variables from the multi-step workflow are present
    if (!doctorName || !patientName || !date || !time || !phone) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "Missing required appointment details." }) 
      };
    }

    // 3. Resolve Doctor ID
    // Maps the conversational doctor name to the unique database ID
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
     * Cross-references the requested slot against existing confirmed appointments.
     * Use .maybeSingle() to return null instead of an error if the slot is free.
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
     * FEATURE INTEGRATION: CONFLICT RESOLUTION (409)
     * If 'existing' is true, it triggers a conflict status.
     * The message is written empathetically for the AI to read back to the patient.
     */
    if (existing) {
      return { 
        statusCode: 409, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Sorry, the time slot ${time} on ${date} with ${doctorName} was just booked by someone else. Please try another time.` 
        }) 
      };
    }

    /**
     * 4. FINAL TRANSACTION
     * Inserts the appointment into the database with a 'confirmed' status.
     * This will trigger updates on the Admin Dashboard in real-time if filtering for this date.
     */
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
    
    // Success confirmation for the Orchestrator
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
        message: "A technical error occurred. Please try again shortly." 
      }) 
    };
  }
};