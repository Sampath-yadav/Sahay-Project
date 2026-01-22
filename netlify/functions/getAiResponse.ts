import { Handler, HandlerEvent } from '@netlify/functions';

// --- TYPE DEFINITIONS ---
interface ChatPart {
  text: string;
}

interface HistoryItem {
  role: 'user' | 'model';
  parts: ChatPart[];
}

interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

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
  }
];

/**
 * Robust Tool Caller
 */
async function executeTool(name: string, args: object, host: string): Promise<any> {
  try {
    const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : 'https';
    const sanitizedHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `${protocol}://${sanitizedHost}/.netlify/functions/${name}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });

    if (!response.ok) return { success: false, message: "Service is temporarily busy." };
    return await response.json();
  } catch (err: any) {
    return { success: false, message: "Network connection issue." };
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY missing.");

    const body = JSON.parse(event.body || '{}');
    const history: HistoryItem[] = body.history || [];
    const host = event.headers['x-forwarded-host'] || event.headers.host || 'sahayhealth.netlify.app';
    
    // DYNAMIC DATE INJECTION
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA'); 
    const tomorrowDate = new Date();
    tomorrowDate.setDate(now.getDate() + 1);
    const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA');
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

CONTEXT:
- Today is ${dayOfWeek}, ${todayStr}.
- Tomorrow is ${tomorrowStr}.

ANTI-HALLUCINATION RULES:
1. NEVER guess or invent doctor names (e.g., Dr. Smith, Dr. Johnson). 
2. DATA-FIRST: You MUST call 'getDoctorDetails' before suggesting a doctor. Only use names provided by the tool.
3. If a tool returns no results, tell the user honestly that no match was found in our directory.

INTELLIGENCE RULES:
1. FUZZY UNDERSTANDING: Understand intent behind typos (e.g., "headack" -> headache).
2. DATE LOGIC: "tomorrow" = ${tomorrowStr}, "today" = ${todayStr}.
3. NO MARKDOWN: Never use asterisks (**), bolding, or headers. Use plain text only.
4. SYMPTOM TEMPLATE: If a user states a problem, respond: "I'm sorry you're not feeling well. We have a [Specialty] available. Would you like to book an appointment?"

STRICT FLOW:
- Identify Symptom -> Call getDoctorDetails -> User picks Real Doctor -> Check Slots -> Collect Info -> Verify -> Book.`
      },
      ...sanitizedMessages
    ];

    // PASS 1: Reasoning & Logic
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.1
      })
    });

    const data: any = await response.json();
    let aiMessage = data.choices[0].message;

    // PASS 2: Tool Handling & Narrative
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
          model: "mistral-small-latest",
          messages: [...messages, aiMessage, ...toolResults],
          temperature: 0.7 
        })
      });

      const finalData: any = await finalResponse.json();
      aiMessage = finalData.choices[0].message;
    }

    // FINAL CLEANUP: Remove any accidental formatting
    const cleanReply = (aiMessage.content || "")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/#{1,6}\s?/g, "")
      .trim();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: cleanReply })
    };

  } catch (error: any) {
    console.error("ORCHESTRATOR_FATAL:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "System encountered an error." })
    };
  }
};