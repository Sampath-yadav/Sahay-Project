const fetch = require('node-fetch');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * TOOL DEFINITIONS
 * These tell the AI exactly what "capabilities" it has.
 */
const tools = [
  {
    type: "function",
    function: {
      name: "getAvailableSlots",
      description: "Step 4 of workflow. Gets available time slots. Call 1: Use doctorName and date. Call 2: Add timeOfDay ('morning'/'afternoon') based on user choice.",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          date: { type: "string", description: "Format: YYYY-MM-DD" },
          timeOfDay: { type: "string", enum: ["morning", "afternoon", "evening"], description: "Optional. Use only after user picks a period." }
        },
        required: ["doctorName", "date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getDoctorDetails",
      description: "Step 2 of workflow. Finds doctors based on specialty or name.",
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
      description: "Step 6 of workflow. Finalizes the booking in the database.",
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
  },
  {
    type: "function",
    function: {
      name: "cancelAppointment",
      description: "Cancels an existing appointment.",
      parameters: {
        type: "object",
        properties: {
          doctorName: { type: "string" },
          patientName: { type: "string" },
          date: { type: "string" }
        },
        required: ["doctorName", "patientName", "date"]
      }
    }
  }
];

/**
 * TOOL EXECUTOR
 * Calls your other Netlify worker functions (external tool integration).
 */
async function executeTool(name, args, host) {
  const url = `https://${host}/.netlify/functions/${name}`;
  console.log(`Executing Tool: ${name} with args:`, args);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });

  if (!response.ok) throw new Error(`Tool ${name} failed to respond.`);
  return await response.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.GROQ_API_KEY;
    const body = JSON.parse(event.body || '{}');
    const { history } = body;
    const host = event.headers.host || 'sahayhealth.netlify.app';
    const currentDate = new Date().toLocaleDateString('en-CA');

    // 1. CONTEXT AWARENESS: Map history to Groq Message Format
    const messages = [
      { 
        role: "system", 
        content: `You are Sahay, a professional English Medical Assistant for Prudence Hospitals.
        
        STRICT WORKFLOW:
        1. Understand Need: Ask for symptoms/specialty.
        2. Find Doctor: Call 'getDoctorDetails'.
        3. Get Date: Ask preferred date.
        4. Check Schedule (2-Step Drill):
           - Call 'getAvailableSlots' (doctor, date) -> Present periods (Morning/Afternoon).
           - Ask user preference.
           - Call 'getAvailableSlots' (doctor, date, timeOfDay) -> Present specific times.
        5. Gather Details: Name and Phone.
        6. Book: Call 'bookAppointment'.
        
        RULES:
        - Current Date: ${currentDate}.
        - Be concise, professional, and empathetic.
        - Never provide medical advice.`
      },
      ...history.map(item => ({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: item.parts[0].text
      }))
    ];

    // 2. ORCHESTRATION: Send request to Groq
    let response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      })
    });

    let data = await response.json();
    let aiMessage = data.choices[0].message;

    // 3. MULTI-STEP REASONING: Handle Tool Calls if triggered
    if (aiMessage.tool_calls) {
      // Add AI's intent to message list
      messages.push(aiMessage);

      // Execute each tool call
      for (const toolCall of aiMessage.tool_calls) {
        const result = await executeTool(
          toolCall.function.name, 
          JSON.parse(toolCall.function.arguments),
          host
        );

        // Feed the tool result back into the history
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result)
        });
      }

      // Final pass: Get natural language reply based on tool results
      const finalResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: messages
        })
      });

      const finalData = await finalResponse.json();
      aiMessage = finalData.choices[0].message;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: aiMessage.content })
    };

  } catch (error) {
    console.error("ORCHESTRATOR_FATAL:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "System failed", details: error.message })
    };
  }
};
