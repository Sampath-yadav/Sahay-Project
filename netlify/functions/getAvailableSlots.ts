import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const { doctorName, date, timeOfDay } = JSON.parse(event.body || '{}');

    if (!doctorName || !date) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "Doctor name and date are required." }) 
      };
    }

    // 1. Fetch Doctor ID and Working Hours
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

    // 2. Generate all possible 30-minute slots based on working hours
    const allPossibleSlots: string[] = [];
    const [startHour, startMinute] = doctorData.working_hours_start.split(':').map(Number);
    const [endHour, endMinute] = doctorData.working_hours_end.split(':').map(Number);
    
    let currentHour = startHour;
    let currentMinute = startMinute;

    while (currentHour < endHour || (currentHour === endHour && currentMinute < endMinute)) {
      allPossibleSlots.push(
        `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`
      );
      currentMinute += 30;
      if (currentMinute >= 60) {
        currentHour++;
        currentMinute -= 60;
      }
    }

    // 3. Fetch already booked appointments for this doctor/date
    const { data: bookedAppointments, error: bookedError } = await supabase
      .from('appointments')
      .select('appointment_time')
      .eq('doctor_id', doctorData.id)
      .eq('appointment_date', date)
      .eq('status', 'confirmed');

    if (bookedError) throw bookedError;

    // 4. Filter out booked slots
    const bookedTimes = bookedAppointments.map(appt => appt.appointment_time.substring(0, 5));
    const availableSlots = allPossibleSlots.filter(slot => !bookedTimes.includes(slot));

    // 5. Categorize slots for AI context
    const morning = availableSlots.filter(s => parseInt(s.split(':')[0]) < 12);
    const afternoon = availableSlots.filter(s => parseInt(s.split(':')[0]) >= 12 && parseInt(s.split(':')[0]) < 17);
    const evening = availableSlots.filter(s => parseInt(s.split(':')[0]) >= 17);

    // 6. Return response based on AI query (General or Specific)
    if (!timeOfDay) {
      const availablePeriods = [];
      if (morning.length > 0) availablePeriods.push('morning');
      if (afternoon.length > 0) availablePeriods.push('afternoon');
      if (evening.length > 0) availablePeriods.push('evening');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, availablePeriods }) };
    }

    const filteredSlots = 
      timeOfDay.toLowerCase() === 'morning' ? morning :
      timeOfDay.toLowerCase() === 'afternoon' ? afternoon :
      timeOfDay.toLowerCase() === 'evening' ? evening : [];

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ success: true, availableSlots: filteredSlots }) 
    };

  } catch (error: any) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: error.message }) 
    };
  }
};