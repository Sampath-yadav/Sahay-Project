const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Gemini API Key missing." }) };
  }

  try {
    const { history } = JSON.parse(event.body || '{}');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = "You are Sahay, a medical assistant for Prudence Hospitals. ALWAYS SPEAK IN TELUGU. Be polite and helpful.";

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "అర్థమైంది. నేను సహాయ్ గా తెలుగులో మీకు సహాయం చేస్తాను." }] },
        ...history.slice(0, -1)
      ]
    });

    const userMessage = history[history.length - 1].parts[0].text;
    const result = await chat.sendMessage(userMessage);
    const response = await result.response;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: response.text() })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "AI Error", details: error.message })
    };
  }
};