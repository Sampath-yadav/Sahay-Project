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
  function: { name: string; arguments: string; };
}

// --- TOOL DEFINITIONS ---
const tools = [
  {
    type: "function",
    function: {
      name: "getAvailableSlots",
      description: "Find availability. Use this ONLY after the user has specified a DATE.",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD. Ask the user for this date." },
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
        properties: { specialty: { type: "string" }, doctorName: { type: "string" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rescheduleAppointment",
      description: "Modify an existing confirmed booking.",
      parameters: {
        type: "object",
        properties: {
          patientName: { type: "string" },
          doctorName: { type: "string" },
          oldDate: { type: "string" },
          newDate: { type: "string" },
          newTime: { type: "string" }
        },
        required: ["patientName", "doctorName", "oldDate"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancelAppointment",
      description: "Cancel a confirmed appointment.",
      parameters: {
        type: "object",
        properties: { doctorName: { type: "string" }, patientName: { type: "string" }, date: { type: "string" } },
        required: ["doctorName", "patientName", "date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "FINAL STEP: Call this ONLY when you have Doctor, Date, Time, Patient Name, and Phone.",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          patientName: { type: "string" },
          phone: { type: "string" },
          date: { type: "string" },
          time: { type: "string" }
        },
        required: ["doctorName", "patientName", "phone", "date", "time"]
      }
    }
  }
];

async function executeTool(name: string, args: object, host: string): Promise<any> {
  try {
    const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : 'https';
    const sanitizedHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `${protocol}://${sanitizedHost}/.netlify/functions/${name}`;
    console.log(`[ORCHESTRATOR] Executing: ${name}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    return await response.json();
  } catch (err: any) {
    return { success: false, message: "Service busy." };
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  try {
    const apiKey = process.env.MISTRAL_API_KEY;
    const body = JSON.parse(event.body || '{}');
    const history: HistoryItem[] = body.history || [];
    const host = event.headers['x-forwarded-host'] || event.headers.host || DEFAULT_HOST;
    
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA');
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

    const messages = [
      { 
        role: "system", 
        content: `You are Sahay, the smart Medical Orchestrator. 
Today is ${dayOfWeek}, ${todayStr}.

STRICT BOOKING WORKFLOW (DO NOT SKIP STEPS):
1. SELECT DOCTOR: Suggest a doctor based on symptoms or name.
2. MANDATORY DATE REQUEST: Once the user agrees to a doctor, you MUST ask: "On which date would you like to book the appointment?"
3. LOCK DATE: DO NOT call 'getAvailableSlots' until the user provides a specific date (e.g., "Tomorrow", "January 26", or "25/01/2026").
4. SHOW PERIODS: After getting the date, call 'getAvailableSlots' for that specific date and show Morning/Afternoon/Evening options.
5. PICK SLOT: Show specific times (e.g., 10:00).
6. GATHER INFO: Get Full Name and Phone.
7. FINALIZE: Call 'bookAppointment' immediately with all details.

RULES:
- NEVER assume a date. Always ask the user first.
- Convert natural dates like "tomorrow" to YYYY-MM-DD before calling tools.
- NO ASTERISKS (**). Plain text only. Friendly and professional.`
      },
      ...history.map(item => ({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: item.parts[0].text
      }))
    ];

    // Pass 1: Reasoning
    const firstResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.1
      })
    });

    const firstData: any = await firstResponse.json();
    let aiMessage = firstData.choices[0].message;

    // Pass 2: Tool Execution
    if (aiMessage.tool_calls) {
      const toolResults = [];
      for (const toolCall of aiMessage.tool_calls as ToolCall[]) {
        const result = await executeTool(toolCall.function.name, JSON.parse(toolCall.function.arguments), host);
        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result)
        });
      }

      const finalResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [...messages, aiMessage, ...toolResults],
          temperature: 0.7 
        })
      });

      const finalData: any = await finalResponse.json();
      aiMessage = finalData.choices[0].message;
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ reply: (aiMessage.content || "").replace(/\*\*/g, "").trim() })
    };

  } catch (error: any) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Service Error" }) };
  }
};