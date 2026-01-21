import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const { doctorName, date, timeOfDay } = JSON.parse(event.body || '{}');

    // Requirement: Ensure essential parameters for lookup are provided
    if (!doctorName || !date) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "Doctor name and date are required." }) 
      };
    }

    // 1. DYNAMIC LOOKUP: Fetch Doctor ID and specific Working Hours
    const { data: doctorData, error: doctorError } = await supabase
      .from('doctors')
      .select('id, working_hours_start, working_hours_end')
      .ilike('name', `%${doctorName}%`)
      .single();

    if (doctorError || !doctorData) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ success: false, message: `Doctor ${doctorName} not found.` }) 
      };
    }

    // 2. DYNAMIC SLOT GENERATION: Calculate 30-minute intervals from database hours
    const allPossibleSlots: string[] = [];
    const [startHour, startMinute] = doctorData.working_hours_start.split(':').map(Number);
    const [endHour, endMinute] = doctorData.working_hours_end.split(':').map(Number);
    
    let currentHour = startHour;
    let currentMinute = startMinute;

    while (currentHour < endHour || (currentHour === endHour && currentMinute < endMinute)) {
      allPossibleSlots.push(
        `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`
      );
      currentMinute += 30; // 30-minute slot duration
      if (currentMinute >= 60) {
        currentHour++;
        currentMinute -= 60;
      }
    }

    // 3. AVAILABILITY FILTERING: Cross-reference with existing confirmed appointments
    const { data: bookedAppointments, error: bookedError } = await supabase
      .from('appointments')
      .select('appointment_time')
      .eq('doctor_id', doctorData.id)
      .eq('appointment_date', date)
      .eq('status', 'confirmed');

    if (bookedError) throw bookedError;

    // Filter out slots that already exist in the database for that date
    const bookedTimes = bookedAppointments.map(appt => appt.appointment_time.substring(0, 5));
    const availableSlots = allPossibleSlots.filter(slot => !bookedTimes.includes(slot));

    // 4. CONVERSATIONAL CATEGORIZATION: Group slots for better UX
    const morning = availableSlots.filter(s => parseInt(s.split(':')[0]) < 12);
    const afternoon = availableSlots.filter(s => parseInt(s.split(':')[0]) >= 12 && parseInt(s.split(':')[0]) < 17);
    const evening = availableSlots.filter(s => parseInt(s.split(':')[0]) >= 17);

    /**
     * 5. DUAL-MODE RESPONSE LOGIC
     * MODE 1 (Period Discovery): If no specific timeOfDay is requested, tell the AI 
     * which general periods have at least one opening.
     */
    if (!timeOfDay) {
      const availablePeriods = [];
      if (morning.length > 0) availablePeriods.push('morning');
      if (afternoon.length > 0) availablePeriods.push('afternoon');
      if (evening.length > 0) availablePeriods.push('evening');
      
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ 
          success: true, 
          availablePeriods,
          message: availablePeriods.length > 0 
            ? `Available periods found for ${doctorName} on ${date}.`
            : `No slots available for ${doctorName} on this date.`
        }) 
      };
    }

    /**
     * MODE 2 (Specific Times): If a period (e.g., 'morning') is provided,
     * return the exact timestamps for the AI to present to the user.
     */
    const period = timeOfDay.toLowerCase();
    const filteredSlots = 
      period === 'morning' ? morning :
      period === 'afternoon' ? afternoon :
      period === 'evening' ? evening : [];

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        period: period,
        availableSlots: filteredSlots 
      }) 
    };

  } catch (error: any) {
    console.error("GET_AVAILABLE_SLOTS_ERROR:", error.message);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: "Error retrieving schedule availability." }) 
    };
  }
};