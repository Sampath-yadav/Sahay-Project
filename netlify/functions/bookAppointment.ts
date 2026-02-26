import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  // 1. Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { doctorName, patientName, date, time, phone } = JSON.parse(event.body || '{}');
    
    // 2. Data Validation
    if (!doctorName || !patientName || !date || !time || !phone) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: "Missing details. Please provide doctor, name, date, time, and phone." 
        }) 
      };
    }

    // --- Phone Number Formatting for India (+91) ---
    let formattedPhone = phone.trim();
    if (formattedPhone.length === 10) {
      formattedPhone = `+91${formattedPhone}`;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = `+${formattedPhone}`;
    }

    // --- STEP 3: Resolve Doctor ID from Name (ANTI-HALLUCINATION LOGIC) ---
    // Clean the name (remove "Dr." and extra spaces) to ensure better matching
    const searchName = doctorName.replace(/Dr\./gi, '').trim();

    const { data: matchingDoctors, error: doctorError } = await supabase
      .from('doctors')
      .select('id, name')
      .ilike('name', `%${searchName}%`);

    if (doctorError || !matchingDoctors || matchingDoctors.length === 0) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Booking Failed: Doctor '${doctorName}' does not exist in our hospital records. Please select a doctor from our verified list.` 
        }) 
      };
    }

    // If multiple matches are found, we must ensure we aren't guessing
    let doctorData;
    if (matchingDoctors.length > 1) {
      // Look for a strict match to see if the AI provided a full name
      const strictMatch = matchingDoctors.find(d => d.name.toLowerCase().includes(searchName.toLowerCase()));
      if (matchingDoctors.length > 1 && !strictMatch) {
         return {
           statusCode: 400,
           headers,
           body: JSON.stringify({
             success: false,
             message: `Ambiguity detected: Multiple doctors match '${doctorName}'. Please provide the full name to avoid booking with the wrong provider.`
           })
         };
      }
      doctorData = strictMatch || matchingDoctors[0];
    } else {
      doctorData = matchingDoctors[0];
    }

    // 4. ATOMIC SAFETY CHECK (Race Condition Protection)
    const { data: existing, error: checkError } = await supabase
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctorData.id)
      .eq('appointment_date', date)
      .eq('appointment_time', time)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (checkError) throw checkError;

    // 5. CONFLICT RESOLUTION
    if (existing) {
      return { 
        statusCode: 409, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Conflict: The ${time} slot with ${doctorData.name} on ${date} was just taken.`,
          instruction: "Inform the user about the conflict and ask for another time slot."
        }) 
      };
    }

    // 6. FINAL TRANSACTION: Update Database
    const { error: insertError } = await supabase
      .from('appointments')
      .insert({ 
        patient_name: patientName, 
        doctor_id: doctorData.id, 
        appointment_date: date, 
        appointment_time: time, 
        phone: formattedPhone,
        status: 'confirmed'
      });

    if (insertError) throw insertError;

    // --- TWILIO SMS NOTIFICATION ---
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (accountSid && authToken && fromNumber) {
      try {
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        const smsParams = new URLSearchParams();
        smsParams.append('To', formattedPhone);
        smsParams.append('From', fromNumber);
        smsParams.append('Body', `Prudence Hospitals: Hi ${patientName}, your appointment with ${doctorData.name} is confirmed for ${date} at ${time}. Thank you!`);

        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: smsParams.toString()
          }
        );
      } catch (smsErr) {
        console.error("SMS notification failed:", smsErr);
      }
    }
    
    // 7. STRUCTURED SUCCESS RESPONSE FOR MISTRAL
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        message: 'Appointment confirmed successfully!',
        bookingSummary: {
          doctor: doctorData.name,
          patient: patientName,
          date: date,
          time: time
        },
        instruction: "Confirm the booking details to the user and end the call politely."
      }) 
    };

  } catch (error: any) {
    console.error("MISTRAL_BOOKING_TOOL_ERROR:", error.message);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ 
        success: false, 
        message: "A database error occurred while finalizing the booking." 
      }) 
    };
  }
};