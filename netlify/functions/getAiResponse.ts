const fetch = require('node-fetch');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * TOOL DEFINITIONS
 * These tell Groq exactly what "capabilities" Sahay has.
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
      description: "Step 6 of workflow. Finalizes the booking in the database. Call only after patient name and phone are collected.",
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

/**
 * TOOL EXECUTOR
 * Robust tool caller that adapts to both local (HTTP) and production (HTTPS) environments.
 */
async function executeTool(name, args, host) {
  // Fix: Check if host is localhost to use http protocol
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const url = `${protocol}://${host}/.netlify/functions/${name}`;
  
  console.log(`Executing Tool: ${url} with args:`, args);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });

    const result = await response.json();
    
    // If the tool returns a specific failure (like 409 conflict), we pass it back to the AI
    if (!response.ok) {
      return { error: true, message: result.message || `Tool ${name} failed.` };
    }
    
    return result;
  } catch (err) {
    console.error(`Tool Execution Error (${name}):`, err.message);
    return { error: true, message: "Connection to tool failed." };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is missing.");

    const body = JSON.parse(event.body || '{}');
    const { history } = body;
    const host = event.headers.host || 'sahayhealth.netlify.app';
    
    // Normalize current date for AI context
    const currentDate = new Date().toLocaleDateString('en-CA');

    // 1. CONTEXT AWARENESS: Build the prompt with strict medical workflow
    const messages = [
      { 
        role: "system", 
        content: `You are Sahay, a professional English Medical Assistant for Prudence Hospitals.
        
        STRICT WORKFLOW:
        1. Understand Need: Ask for symptoms or specialty if unknown.
        2. Find Doctor: Call 'getDoctorDetails'.
        3. Get Date: Ask for a preferred date (Format: YYYY-MM-DD).
        4. Check Schedule:
           - Call 'getAvailableSlots' (doctorName, date) -> Present Morning/Afternoon periods.
           - Once user picks a period, call 'getAvailableSlots' (doctorName, date, timeOfDay) -> Present specific 30-min times.
        5. Patient Info: Ask for Full Name and Phone Number.
        6. Book: Confirm all details clearly, then call 'bookAppointment'.
        
        CONSTRAINTS:
        - Current Date: ${currentDate}.
        - Be concise and professional.
        - If 'bookAppointment' returns a conflict error (slot taken), explain it empathetically and ask for another time.
        - Never offer medical advice.`
      },
      ...history.map(item => ({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: item.parts[0].text
      }))
    ];

    // 2. AI REASONING PASS 1
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
    if (data.error) throw new Error(data.error.message);

    let aiMessage = data.choices[0].message;

    // 3. MULTI-STEP REASONING: Handle Tool Execution
    if (aiMessage.tool_calls) {
      messages.push(aiMessage);

      for (const toolCall of aiMessage.tool_calls) {
        const result = await executeTool(
          toolCall.function.name, 
          JSON.parse(toolCall.function.arguments),
          host
        );

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result)
        });
      }

      // 4. AI REASONING PASS 2: Generate natural reply based on tool results
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
      body: JSON.stringify({ error: "Service Unavailable", details: error.message })
    };
  }
};