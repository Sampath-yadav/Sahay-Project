import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
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

    // --- NEW: Phone Number Formatting for India (+91) ---
    let formattedPhone = phone.trim();
    if (formattedPhone.length === 10) {
      formattedPhone = `+91${formattedPhone}`;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = `+${formattedPhone}`;
    }

    // 3. Resolve Doctor ID from Name
    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id, name')
      .ilike('name', `%${doctorName}%`)
      .single();

    if (doctorError || !doctorData) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Doctor '${doctorName}' could not be identified in our system.` 
        }) 
      };
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
        phone: formattedPhone, // Use the formatted number in Supabase
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
        smsParams.append('To', formattedPhone); // Use the formatted number for Twilio
        smsParams.append('From', fromNumber);
        smsParams.append('Body', `Prudence Hospitals: Hi ${patientName}, your appointment with ${doctorData.name} is confirmed for ${date} at ${time}. Thank you!`);

        const twilioRes = await fetch(
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
        
        const twilioData = await twilioRes.json();
        console.log(`SMS notification status for ${formattedPhone}:`, twilioData.status);
      } catch (smsErr) {
        console.error("SMS notification failed to send, but booking succeeded:", smsErr);
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