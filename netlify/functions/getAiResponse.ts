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
          date: { type: "string" },
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
      name: "rescheduleAppointment",
      description: "Step 1: VERIFY (Patient, Doctor, Old Date). Step 2: EXECUTE (Patient, Doctor, Old Date, New Date, New Time).",
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
      name: "bookAppointment",
      description: "Finalize a NEW appointment booking.",
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

// --- UTILITY FUNCTIONS ---
async function executeTool(name: string, args: object, host: string): Promise<any> {
  try {
    const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : 'https';
    const sanitizedHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `${protocol}://${sanitizedHost}/.netlify/functions/${name}`;
    
    console.log(`[SAHAY-TOOL] Executing: ${name} with args:`, JSON.stringify(args));
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });

    if (!response.ok) return { success: false, message: "Service temporarily busy." };
    return await response.json();
  } catch (err: any) {
    return { success: false, message: "Network connection issue." };
  }
}

// --- MAIN HANDLER ---
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  try {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY missing.");

    const body = JSON.parse(event.body || '{}');
    const history: HistoryItem[] = body.history || [];
    const host = event.headers['x-forwarded-host'] || event.headers.host || DEFAULT_HOST;
    
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA');
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

    const sanitizedMessages = history
      .filter(item => item.parts && item.parts[0]?.text?.trim() !== "")
      .map(item => ({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: item.parts[0].text
      }));

    const messages = [
      { 
        role: "system", 
        content: `You are Sahay, the intelligent Health Assistant for Prudence Hospitals.
Today is ${dayOfWeek}, ${todayStr}.

INTENT RECOVERY & RESILIENCE:
1. If the user uses words like "reset", "reset you late", "move", or "change date", interpret this as "RESCHEDULE". 
2. Never apologize for missing capabilities regarding appointments. You HAVE the 'rescheduleAppointment' tool and it is fully functional.

ENTITY EXTRACTION RULE:
- Combined strings like "Mahesh Sampath 23" mean: Doctor="Mahesh", Patient="Sampath", Date="23".

STRICT RESCHEDULE WORKFLOW (DO NOT DEVIATE):
- Step 1: User says "reschedule". Ask for Doctor, Patient, and Old Date.
- Step 2: Receive details. Call 'getDoctorDetails' THEN call 'rescheduleAppointment' (verification mode) with those 3 fields.
- Step 3: If verification successful, ask: "I found your record. What is the new date you would like to move to?"
- Step 4: Receive New Date. Call 'getAvailableSlots'.
- Step 5: User picks time. Call 'rescheduleAppointment' with all 5 fields to finalize.

RULES:
- NO ASTERISKS (**). NO MARKDOWN.
- Be conversational but professional. Focus on the medical context.`
      },
      ...sanitizedMessages
    ];

    // PASS 1: Logic Pass
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

    // PASS 2: Tool Execution
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

    const cleanReply = (aiMessage.content || "")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/#{1,6}\s?/g, "")
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
      body: JSON.stringify({ error: "Workflow interrupted. Please try again." })
    };
  }
};