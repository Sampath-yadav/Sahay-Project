const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event: any) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is missing.");

    const body = JSON.parse(event.body || '{}');
    const { history } = body;

    if (!history || history.length === 0) {
      throw new Error("No conversation history provided.");
    }

    // Get the latest user message
    const userMessage = history[history.length - 1].parts[0].text;

    const payload = {
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are Sahay, the Senior Hospital Coordinator for Prudence Hospitals. 
          Your tone is professional, empathetic, and efficient. 
          
          CORE TASKS:
          1. BOOKING: Collect Patient Name, Specialty (Cardiology, Orthopedics, etc.), and Date/Time.
          2. RESCHEDULING: Ask for the existing appointment details and the new preferred time.
          3. CANCELING: Confirm the appointment details before processing the cancellation.
          
          CONSTRAINTS:
          - ALWAYS speak in clear, professional English.
          - If information is missing, ask for it politely.
          - Keep responses concise and clinical.`
        },
        { role: "user", content: userMessage }
      ],
      temperature: 0.6, // Lowered for more consistent/robust professional responses
      max_tokens: 800
    };

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
      throw new Error(data.error?.message || "Groq API error.");
    }

    const aiReply = data.choices[0].message.content;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: aiReply })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("COORDINATOR_ERROR:", errorMessage);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Coordinator connection failed", details: errorMessage })
    };
  }
};