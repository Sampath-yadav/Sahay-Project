const fetch = require('node-fetch');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Handle the browser's security check (CORS)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is missing in Netlify settings.");
    }

    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    // Convert the conversation into a format Groq understands
    // We only take the last message for simplicity, or map the whole history
    const userMessage = history[history.length - 1].parts[0].text;

    const payload = {
      model: "llama-3.3-70b-versatile", // Fast and free-tier friendly model
      messages: [
        {
          role: "system",
          content: "You are Sahay, an AI medical assistant for Prudence Hospitals. ALWAYS SPEAK IN TELUGU. Be polite, concise, and helpful."
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.7,
      max_tokens: 1024
    };

    // Call the Groq API directly
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API Error:", data);
      throw new Error(data.error?.message || "Failed to get response from Groq.");
    }

    // Extract the text reply from Groq's response structure
    const aiReply = data.choices[0].message.content;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: aiReply })
    };

  } catch (error) {
    console.error("GROQ_BRAIN_ERROR:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "Brain connection failed", 
        details: error.message 
      })
    };
  }
};