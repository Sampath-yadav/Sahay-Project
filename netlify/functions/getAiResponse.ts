const { GoogleGenerativeAI } = require('@google/generative-ai');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "API Key missing." }) };
    }

    // 1. Initialize the Google AI with your key
    const genAI = new GoogleGenerativeAI(apiKey);

    // 2. FIX: We use 'gemini-1.5-flash' which is the most stable version
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash" 
    });

    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    const systemPrompt = "You are Sahay, an AI assistant for Prudence Hospitals. ALWAYS SPEAK IN TELUGU.";

    // 3. Start the chat session
    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "అర్థమైంది. నేను సహాయ్ గా తెలుగులో మీకు సహాయం చేస్తాను." }] },
        ...(history || []).slice(0, -1)
      ]
    });

    const userMessage = history[history.length - 1].parts[0].text;
    
    // 4. Send the message
    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    const text = response.text();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: text })
    };

  } catch (error) {
    console.error("DETAILED ERROR LOG:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "Google AI Mismatch", 
        details: error.message 
      })
    };
  }
};
