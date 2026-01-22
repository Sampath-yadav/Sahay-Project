import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * RETRY CONFIGURATION
 * Exponential backoff: 100ms, 200ms, 400ms (3 total attempts)
 */
const isTransientError = (error: any): boolean => {
  const msg = error?.message?.toLowerCase() || '';
  const code = error?.code || '';
  
  return (
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT'
  );
};

const queryWithRetry = async (query: any, maxAttempts = 3) => {
  const delays = [100, 200, 400];
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await query();
    } catch (error: any) {
      if (attempt === maxAttempts - 1 || !isTransientError(error)) {
        throw error;
      }
      
      const delayMs = delays[attempt];
      console.log(`[RETRY] Attempt ${attempt + 1}/${maxAttempts} failed. Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // 1. SANITIZED CONFIGURATION
    const rawUrl = process.env.SUPABASE_URL || '';
    const supabaseUrl = rawUrl.trim().replace(/\/$/, ""); 
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

    if (!supabaseUrl.startsWith('https')) {
      throw new Error("Invalid database configuration.");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2. INPUT VALIDATION
    const { doctorName, date, timeOfDay } = JSON.parse(event.body || '{}');

    if (!doctorName || !date) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ success: false, message: "Doctor name and date are required." }) 
      };
    }

    // 3. FETCH DOCTOR'S SPECIFIC WORKING HOURS (with retry)
    let doctor;
    let docError;
    
    try {
      const result = await queryWithRetry(() =>
        supabase
          .from('doctors')
          .select('id, name, working_hours_start, working_hours_end')
          .ilike('name', `%${doctorName.replace(/Dr\./gi, '').trim()}%`)
          .single()
      );
      
      doctor = result.data;
      docError = result.error;
    } catch (error: any) {
      docError = error;
    }

    if (docError || !doctor) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          message: `Could not find schedule for ${doctorName}.`,
          error_type: "DOCTOR_NOT_FOUND"
        }) 
      };
    }

    // 4. DYNAMIC SLOT GENERATION (30-minute intervals)
    const slots: string[] = [];
    const [startH, startM] = doctor.working_hours_start.split(':').map(Number);
    const [endH, endM] = doctor.working_hours_end.split(':').map(Number);
    
    let currentH = startH;
    let currentM = startM;

    while (currentH < endH || (currentH === endH && currentM < endM)) {
      const timeString = `${String(currentH).padStart(2, '0')}:${String(currentM).padStart(2, '0')}`;
      slots.push(timeString);
      
      currentM += 30;
      if (currentM >= 60) {
        currentH++;
        currentM = 0;
      }
    }

    // 5. FILTER OUT BOOKED APPOINTMENTS (with retry)
    let booked;
    try {
      const result = await queryWithRetry(() =>
        supabase
          .from('appointments')
          .select('appointment_time')
          .eq('doctor_id', doctor.id)
          .eq('appointment_date', date)
          .eq('status', 'confirmed')
      );
      booked = result.data;
    } catch (error: any) {
      console.error('[SLOT_QUERY_ERROR]:', error.message);
      booked = null;
    }

    const bookedTimes = (booked || []).map((b: any) => b.appointment_time.substring(0, 5));
    const available = slots.filter(s => !bookedTimes.includes(s));

    // 6. CATEGORIZE FOR CONVERSATIONAL FLOW
    const morning = available.filter(t => parseInt(t.split(':')[0]) < 12);
    const afternoon = available.filter(t => {
      const h = parseInt(t.split(':')[0]);
      return h >= 12 && h < 17;
    });
    const evening = available.filter(t => parseInt(t.split(':')[0]) >= 17);

    // 7. RESPOND BASED ON AI REQUEST MODE
    if (!timeOfDay) {
      // MODE: Summary (Morning/Afternoon/Evening)
      const summary = [];
      if (morning.length > 0) summary.push({ period: 'morning', count: morning.length });
      if (afternoon.length > 0) summary.push({ period: 'afternoon', count: afternoon.length });
      if (evening.length > 0) summary.push({ period: 'evening', count: evening.length });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          doctorName: doctor.name,
          date,
          periods: summary,
          instruction: summary.length > 0 
            ? "Tell the user which periods (morning/afternoon/evening) have slots available and ask which they prefer."
            : "No slots available today. Suggest checking tomorrow."
        })
      };
    } else {
      // MODE: Specific Time Slots
      const target = timeOfDay.toLowerCase();
      const finalSlots = target === 'morning' ? morning : target === 'afternoon' ? afternoon : evening;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          doctorName: doctor.name,
          date,
          period: target,
          slots: finalSlots,
          instruction: `List these ${target} slots for the user and ask them to pick one.`
        })
      };
    }

  } catch (error: any) {
    console.error("[SLOT_TOOL_ERROR]:", error.message);
    
    // Determine appropriate HTTP status based on error type
    let statusCode = 500;
    let errorType = "UNKNOWN_ERROR";
    
    if (isTransientError(error)) {
      statusCode = 503; // Service Unavailable
      errorType = "DATABASE_TEMPORARILY_UNAVAILABLE";
    } else if (error.message.includes('timeout')) {
      statusCode = 504; // Gateway Timeout
      errorType = "REQUEST_TIMEOUT";
    }
    
    return { 
      statusCode,
      headers, 
      body: JSON.stringify({ 
        success: false, 
        message: "I encountered a minor glitch checking the schedule. Let me try that again.",
        error_type: errorType
      }) 
    };
  }
};