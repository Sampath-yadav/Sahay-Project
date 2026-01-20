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
    if (!apiKey) throw new Error("GEMINI_API_KEY is missing in Netlify Settings.");

    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    // 1. We manually target the STABLE v1 endpoint (No more v1beta 404!)
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = "You are Sahay, a medical assistant for Prudence Hospitals. ALWAYS SPEAK IN TELUGU.";

    // 2. Prepare the data exactly how Google wants it
    const contents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "అర్థమైంది. నేను ప్రుడెన్స్ హాస్పిటల్స్ అసిస్టెంట్‌గా మీకు తెలుగులో సహాయం చేస్తాను." }] },
      ...history.map(item => ({
        role: item.role === 'model' ? 'model' : 'user',
        parts: item.parts
      }))
    ];

    // 3. Send the request directly
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    // 4. Extract the text reply
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
      body: JSON.stringify({ error: "Direct Connection Failed", details: error.message })
    };
  }
};