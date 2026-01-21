// Import the workers
const { workerFunctions } = require('./workerFunctions');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Define the "Tools" menu for the AI
const tools = [
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "Book a new hospital appointment",
      parameters: {
        type: "object",
        properties: {
          patientName: { type: "string" },
          specialty: { type: "string" },
          dateTime: { type: "string" }
        },
        required: ["patientName", "specialty", "dateTime"]
      }
    }
  }
];

exports.handler = async (event: { httpMethod: string; body: string }) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.GROQ_API_KEY;
    const { history } = JSON.parse(event.body || '{}');
    const userMessage = history[history.length - 1].parts[0].text;

    // 1. Ask the AI (The Boss) to analyze the request
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are Sahay. Use tools to book appointments. Only call the tool if you have Name, Specialty, and Time." },
          { role: "user", content: userMessage }
        ],
        tools: tools,
        tool_choice: "auto"
      })
    });

    const data = await response.json();
    const message = data.choices[0].message;

    // 2. Orchestration: Check if the Boss wants a Worker to act
    if (message.tool_calls) {
      const toolCall = message.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);
      
      // Delegate to the Worker
      const result = await workerFunctions[toolCall.function.name](args);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: result.displayMessage, data: result.data })
      };
    }

    // 3. Fallback: Just return AI's conversational text
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: message.content })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { statusCode: 500, headers, body: JSON.stringify({ error: errorMessage }) };
  }
};