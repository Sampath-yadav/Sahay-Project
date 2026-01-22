import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * FEATURE: Dynamic Rescheduling Worker
 * Uses precise targeting and relational mapping to move medical appointments.
 */
export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  
  // 1. CORS Guard: Handle pre-flight requests from the browser
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // 2. Environment Guard: Verify database connectivity
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: "Internal configuration error." }) 
    };
  }

  try {
    // 3. Parametric Extraction: Destructure the complex set of inputs
    const { patientName, doctorName, oldDate, newDate, newTime } = JSON.parse(event.body || '{}');
    
    if (!patientName || !doctorName || !oldDate || !newDate || !newTime) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ success: false, message: "Missing required details for rescheduling." }) 
      };
    }

    // 4. Reference Resolution: Resolve Doctor Name to Database ID
    // Logic: Fuzzy search allows "Dr. Sarah" to match "Dr. Sarah Mitchell"
    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id, name')
      .ilike('name', `%${doctorName}%`)
      .limit(1)
      .single();

    if (doctorError || !doctorData) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ success: false, message: `I couldn't find a doctor named ${doctorName} in our system.` }) 
      };
    }

    // 5. Targeted Update: Precise 4-point matching
    // Logic: Targets a specific confirmed appointment for a specific patient/doctor/date
    const { data: updatedData, error: updateError } = await supabase
      .from('appointments')
      .update({ 
        appointment_date: newDate, 
        appointment_time: newTime 
      })
      .match({ 
        patient_name: patientName, 
        doctor_id: doctorData.id, 
        appointment_date: oldDate,
        status: 'confirmed' // State-dependent: prevents rescheduling cancelled ones
      })
      .select(); // Requirement: Post-action verification

    if (updateError) throw updateError;

    // 6. Verification: Check affected row count
    if (!updatedData || updatedData.length === 0) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `I couldn't find a confirmed appointment for ${patientName} with Dr. ${doctorData.name} on ${oldDate}. Please check the date and try again.` 
        }) 
      };
    }

    // 7. Narrative Response: Dynamic and AI-friendly message
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        message: `Excellent! I have successfully rescheduled the appointment for ${patientName}. The new time is set for ${newDate} at ${newTime} with Dr. ${doctorData.name}.` 
      }) 
    };

  } catch (error: any) {
    console.error("Reschedule Error:", error.message);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: "Database update failed. Please try again." }) 
    };
  }
};