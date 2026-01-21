import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * WORKER FUNCTIONS (Internal)
 * These handle the actual database logic.
 */
const workers = {
  bookAppointment: async (args: { patientName: string, specialty: string, dateTime: string, phone: string }) => {
    try {
      // 1. Resolve Doctor ID from Specialty
      const { data: doctorData, error: doctorError } = await supabase
        .from('doctors')
        .select('id, name')
        .ilike('specialization', `%${args.specialty}%`)
        .limit(1)
        .single();

      if (doctorError || !doctorData) {
        return { success: false, msg: `I couldn't find a doctor available for ${args.specialty}.` };
      }

      // 2. Format Date/Time (Assuming AI sends "YYYY-MM-DD HH:mm")
      const [date, ...timeParts] = args.dateTime.split(' ');
      const time = timeParts.join(' ');

      // 3. Insert into Supabase
      const { data, error } = await supabase
        .from('appointments')
        .insert({
          patient_name: args.patientName,
          doctor_id: doctorData.id,
          appointment_date: date,
          appointment_time: time,
          phone: args.phone,
          status: 'confirmed'
        })
        .select()
        .single();

      if (error) throw error;

      return { 
        success: true, 
        msg: `Perfect! I've booked your appointment with Dr. ${doctorData.name} for ${args.dateTime}. ID: ${data.id}` 
      };
    } catch (err: any) {
      return { success: false, msg: `Database error: ${err.message}` };
    }
  }
};

/**
 * TOOL DEFINITION
 * This tells Llama what data it needs to extract from the user.
 */
const tools = [
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "Registers a new appointment in the hospital database.",
      parameters: {
        type: "object",
        properties: {
          patientName: { type: "string", description: "The patient's full name" },
          specialty: { type: "string", description: "The medical department (e.g. Cardiology)" },
          dateTime: { type: "string", description: "The date and time (e.g. 2025-05-20 10:00 AM)" },
          phone: { type: "string", description: "The patient's contact phone number" }
        },
        required: ["patientName", "specialty", "dateTime", "phone"]
      }
    }
  }
];

export const handler = async (event: any) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.GROQ_API_KEY;
    const { history } = JSON.parse(event.body || '{}');
    const userMessage = history[history.length - 1].parts[0].text;

    // 1. Boss (AI) reviews the request
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { 
            role: "system", 
            content: "You are Sahay. Use the bookAppointment tool ONLY when you have the Name, Specialty, Date/Time, and Phone. If any are missing, ask the user politely." 
          },
          { role: "user", content: userMessage }
        ],
        tools: tools,
        tool_choice: "auto"
      })
    });

    const data = await response.json();
    const aiMessage = data.choices[0].message;

    // 2. Orchestration: If AI triggers a tool, run the internal Worker
    if (aiMessage.tool_calls) {
      const call = aiMessage.tool_calls[0];
      const args = JSON.parse(call.function.arguments);

      if (call.function.name === "bookAppointment") {
        const result = await workers.bookAppointment(args);
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ reply: result.msg })
        };
      }
    }

    // 3. Simple Text Response (if no tool was triggered)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: aiMessage.content })
    };

  } catch (error: any) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: error.message }) 
    };
  }
};