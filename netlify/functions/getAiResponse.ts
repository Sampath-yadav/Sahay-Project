const { GoogleGenerativeAI } = require('@google/generative-ai');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // 1. Handle Pre-flight request
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // 2. Check for the API Key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("CRITICAL ERROR: GEMINI_API_KEY is missing in Netlify settings!");
      return { 
        statusCode: 500, 
        headers, 
        body: JSON.stringify({ error: "API Key is missing. Please check Netlify settings." }) 
      };
    }

    // 3. Parse the message from your website
    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    if (!history || !Array.isArray(history)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid conversation history." }) };
    }

    // 4. Connect to Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = "You are Sahay, an AI medical assistant for Prudence Hospitals. ALWAYS SPEAK IN TELUGU. Be polite and helpful.";

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "అర్థమైంది. నేను సహాయ్ గా తెలుగులో మీకు సహాయం చేస్తాను." }] },
        ...history.slice(0, -1)
      ]
    });

    const userMessage = history[history.length - 1].parts[0].text;
    
    // 5. Send to AI
    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    const text = response.text();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: text })
    };

  } catch (error) {
    // This will print the EXACT error in your Netlify logs
    console.error("DETAILED ERROR LOG:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "AI logic failed", details: error.message })
    };
  }
};