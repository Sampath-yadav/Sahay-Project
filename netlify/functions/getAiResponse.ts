const fetch = require('node-fetch');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    // 1. We use v1beta and the "-latest" suffix to ensure it finds the model
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

    const systemPrompt = "You are Sahay, a medical assistant for Prudence Hospitals. ALWAYS SPEAK IN TELUGU. Be helpful and kind.";

    // 2. Formatting the conversation properly for Google
    const contents = [
      {
        role: "user",
        parts: [{ text: systemPrompt }]
      },
      {
        role: "model",
        parts: [{ text: "అర్థమైంది. నేను సహాయ్ గా తెలుగులో మీకు సహాయం చేస్తాను." }]
      },
      ...history.map(item => ({
        role: item.role === 'model' ? 'model' : 'user',
        parts: item.parts
      }))
    ];

    // 3. Make the call
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents })
    });

    const data = await response.json();

    // 4. Detailed error checking
    if (!response.ok) {
      console.error("Google API Error Response:", data);
      throw new Error(data.error?.message || "Google API failed to respond.");
    }

    if (!data.candidates || !data.candidates[0]) {
      throw new Error("AI returned an empty response.");
    }

    const aiReply = data.candidates[0].content.parts[0].text;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: aiReply })
    };

  } catch (error) {
    console.error("ULTIMATE ERROR LOG:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "AI Connection Error", details: error.message })
    };
  }
};