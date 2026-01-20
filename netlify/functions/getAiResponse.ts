const { GoogleGenerativeAI } = require('@google/generative-ai');

// Standard headers for all responses
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // 1. Handle CORS Pre-flight (Important for browser security)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // 2. Strong Key Validation
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Deployment Error: GEMINI_API_KEY is not defined in Netlify.");
      return { 
        statusCode: 500, 
        headers, 
        body: JSON.stringify({ error: "Server configuration error: Key missing." }) 
      };
    }

    // 3. Dynamic Initialization
    // This matches the ^0.21.0 or newer library in your package.json
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // We use the 'gemini-1.5-flash' model which is fast and supports Telugu well
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash" 
    });

    // 4. Parse Request Body safely
    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    if (!history || !Array.isArray(history) || history.length === 0) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "Conversation history is required." }) 
      };
    }

    // 5. Strong Persona (System Prompt)
    const systemPrompt = `You are Sahay, a helpful AI medical assistant for Prudence Hospitals. 
    ALWAYS SPEAK IN TELUGU. 
    Keep your answers concise, empathetic, and medically professional.`;

    // 6. Dynamic Chat Session
    // We start the chat by injecting the system prompt as the first instruction
    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "అర్థమైంది. నేను ప్రుడెన్స్ హాస్పిటల్స్ అసిస్టెంట్‌గా మీకు తెలుగులో సహాయం చేస్తాను." }] },
        // Add the previous conversation but exclude the very last user message
        ...history.slice(0, -1) 
      ]
    });

    // 7. Get User Message and Send
    const lastUserMessage = history[history.length - 1].parts[0].text;
    
    // Using sendMessage makes the conversation feel stateful
    const result = await chat.sendMessage(lastUserMessage);
    const response = await result.response;
    const aiText = response.text();

    // 8. Return Success
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: aiText })
    };

  } catch (error) {
    // 9. Detailed Error Analysis (Helps you find the exact problem)
    console.error("STRONG ERROR LOG:", {
      message: error.message,
      status: error.status,
      type: error.constructor.name
    });

    // Handle the specific 404 "Not Found" error gracefully
    if (error.message.includes('404') || error.message.includes('not found')) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          error: "Model Connection Error", 
          details: "Google could not find the Gemini model. This usually happens if the library version and model name don't match. Please Clear Cache and Re-deploy."
        })
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "AI Brain Failure", 
        message: error.message 
      })
    };
  }
};