import { Handler, HandlerEvent } from '@netlify/functions';

// --- CONSTANTS & CONFIGURATION ---
const MISTRAL_MODEL = "mistral-small-latest";
const DEFAULT_HOST = 'sahayhealth.netlify.app';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// --- TYPE DEFINITIONS ---
interface ChatPart { text: string; }
interface HistoryItem { role: 'user' | 'model'; parts: ChatPart[]; }

interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

// --- TOOL DEFINITIONS ---
const tools = [
  {
    type: "function",
    function: {
      name: "getAvailableSlots",
      description: "Find availability. REQUIRED: doctorName, date (YYYY-MM-DD).",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          timeOfDay: { type: "string", enum: ["morning", "afternoon", "evening"] }
        },
        required: ["doctorName", "date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getDoctorDetails",
      description: "Search for doctors by name or specialty.",
      parameters: {
        type: "object",
        properties: {
          specialty: { type: "string" },
          doctorName: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "Finalize booking. Call ONLY after user confirms summary is correct.",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          patientName: { type: "string" },
          phone: { type: "string" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          time: { type: "string" }
        },
        required: ["doctorName", "patientName", "phone", "date", "time"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancelAppointment",
      description: "Cancel an existing appointment. REQUIRED: doctorName, patientName, date (YYYY-MM-DD).",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          patientName: { type: "string" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
        },
        required: ["doctorName", "patientName", "date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rescheduleAppointment",
      description: "Move an existing appointment to a new date/time. REQUIRED: patientName, doctorName, oldDate, newDate, newTime.",
      parameters: {
        type: "object",
        properties: {
          patientName: { type: "string" },
          doctorName: { type: "string" },
          oldDate: { type: "string", description: "The original appointment date (YYYY-MM-DD)." },
          newDate: { type: "string", description: "The desired new appointment date (YYYY-MM-DD)." },
          newTime: { type: "string", description: "The desired new time (HH:MM)." }
        },
        required: ["patientName", "doctorName", "oldDate", "newDate", "newTime"]
      }
    }
  }
];

// --- UTILITY FUNCTIONS ---

/**
 * Executes a tool by calling the corresponding Netlify function.
 */
async function executeTool(name: string, args: object, host: string): Promise<any> {
  try {
    const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : 'https';
    const sanitizedHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `${protocol}://${sanitizedHost}/.netlify/functions/${name}`;
    
    console.log(`[SAHAY-TOOL] Executing: ${name} | URL: ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });

    if (!response.ok) {
      console.error(`[SAHAY-TOOL] Error: ${name} returned status ${response.status}`);
      return { success: false, message: "The specific tool is temporarily unavailable." };
    }
    
    return await response.json();
  } catch (err: any) {
    console.error(`[SAHAY-TOOL] Network/Fetch Error: ${err.message}`);
    return { success: false, message: "Network connection issue reaching the tool." };
  }
}

// --- MAIN HANDLER ---

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  try {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY is missing in environment variables.");

    const body = JSON.parse(event.body || '{}');
    const history: HistoryItem[] = body.history || [];
    const host = event.headers['x-forwarded-host'] || event.headers.host || DEFAULT_HOST;
    
    // 1. Generate Temporal Context
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
    const tomorrowDate = new Date();
    tomorrowDate.setDate(now.getDate() + 1);
    const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA');
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

    // 2. Prepare Conversation History
    const sanitizedMessages = history
      .filter(item => item.parts && item.parts[0]?.text?.trim() !== "")
      .map(item => ({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: item.parts[0].text
      }));

    // 3. Construct System Prompt
    const messages = [
      { 
        role: "system", 
        content: `You are Sahay, the intelligent Health Assistant for Prudence Hospitals.

CONTEXT:
- Today is ${dayOfWeek}, ${todayStr}.
- Tomorrow is ${tomorrowStr}.

ANTI-HALLUCINATION RULES:
1. NEVER guess or invent doctor names. Call 'getDoctorDetails' to verify.
2. DATA-FIRST: Always call a tool before making factual claims about schedules or availability.

INTELLIGENCE RULES:
1. FUZZY UNDERSTANDING: Map intent behind typos (e.g., "headack" -> headache).
2. DATE NORMALIZATION: Convert "tomorrow", "today", or "23/02/26" to YYYY-MM-DD for tool calls.
3. NO MARKDOWN: Plain text only. No asterisks (**), no bold, no headers.

STRICT RESCHEDULE WORKFLOW (STEP-BY-STEP):
1. TURN 1: If the user says "reschedule", ask for: 1. Doctor's name, 2. Patient's name, and 3. Original (old) date.
2. TURN 2: After receiving those 3, ask: "What is the new date you would like to reschedule to?"
3. TURN 3: Once you have the new date, call 'getAvailableSlots' to show available times for that doctor/date.
4. TURN 4: Once the user picks a time, call 'rescheduleAppointment' with (Patient, Doctor, Old Date, New Date, New Time).
5. TURN 5: Confirm success clearly.

BOOKING LOGIC:
- Problem -> Suggest Specialty -> List Doctors -> Pick Period -> Pick Time -> Get Info -> Verify -> Book.

SYMPTOM TRIAGE:
- "I'm sorry you're not feeling well. We have a [Specialty] available. Would you like to book an appointment?"`
      },
      ...sanitizedMessages
    ];

    // 4. PASS 1: Mistral reasoning and tool selection
    const firstResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${apiKey}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.1 // Low temperature for high precision in tool calling
      })
    });

    const firstData: any = await firstResponse.json();
    if (firstData.error) throw new Error(`Mistral Pass 1 Error: ${firstData.error.message}`);
    
    let aiMessage = firstData.choices[0].message;

    // 5. Tool execution phase
    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
      const toolResults = [];
      
      for (const toolCall of aiMessage.tool_calls as ToolCall[]) {
        const result = await executeTool(
          toolCall.function.name, 
          JSON.parse(toolCall.function.arguments),
          host
        );
        
        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result)
        });
      }

      // 6. PASS 2: Final response with tool results
      const finalResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [...messages, aiMessage, ...toolResults],
          temperature: 0.7 // Slightly higher for more natural speech
        })
      });

      const finalData: any = await finalResponse.json();
      if (finalData.error) throw new Error(`Mistral Pass 2 Error: ${finalData.error.message}`);
      aiMessage = finalData.choices[0].message;
    }

    // 7. Cleanup and Output
    const cleanReply = (aiMessage.content || "")
      .replace(/\*\*/g, "")      // Strip Bold
      .replace(/__/g, "")      // Strip Italics
      .replace(/#{1,6}\s?/g, "") // Strip Headers
      .trim();

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ reply: cleanReply })
    };

  } catch (error: any) {
    console.error("[SAHAY-CRITICAL]:", error.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ 
        error: "System Interrupted", 
        message: "I encountered a problem processing that request. Please try again." 
      })
    };
  }
};