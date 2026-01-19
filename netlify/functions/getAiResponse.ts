import { GoogleGenerativeAI } from '@google/generative-ai';
import { Handler } from '@netlify/functions';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const getFormattedDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'CORS successful' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "API Key missing in Netlify." }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    let { history } = body;

    if (!history || !Array.isArray(history)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid history." }) };
    }

    // --- FIX 400 ERROR: SANITIZE HISTORY ---
    // This ensures no empty parts or corrupted messages are sent to Google
    const cleanHistory = history.filter(item => 
      item.parts && 
      item.parts.length > 0 && 
      (item.parts[0].text || item.parts[0].functionCall || item.parts[0].functionResponse)
    );

    const todayStr = getFormattedDate(new Date());
    const tomorrowStr = getFormattedDate(new Date(Date.now() + 86400000));

    const systemPrompt = `You are Sahay, an AI for Prudence Hospitals. Speak ONLY in Telugu. Today: ${todayStr}.`;

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // --- FIX 404 ERROR: SPECIFIC MODEL INITIALIZATION ---
    // We explicitly request the model without a version prefix to let the SDK handle it
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tools: [{
        functionDeclarations: [
          { name: "getAllSpecialties", description: "List specialties." },
          { 
            name: "getDoctorDetails", 
            description: "Find doctors.",
            parameters: { type: "OBJECT", properties: { specialty: { type: "STRING" } } }
          },
          {
            name: "getAvailableSlots",
            description: "Check slots.",
            parameters: { type: "OBJECT", properties: { doctorName: { type: "STRING" }, date: { type: "STRING" } }, required: ["doctorName", "date"] }
          },
          {
            name: "bookAppointment",
            description: "Book now.",
            parameters: { type: "OBJECT", properties: { doctorName: { type: "STRING" }, patientName: { type: "STRING" }, phone: { type: "STRING" }, date: { type: "STRING" }, time: { type: "STRING" } }, required: ["doctorName", "patientName", "phone", "date", "time"] }
          }
        ]
      }]
    });

    // Start Chat with cleaned history
    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "అర్థమైంది. నేను సహాయ్ గా తెలుగులో మీకు సహాయం చేస్తాను." }] },
        ...cleanHistory.slice(0, -1) // Exclude the very last message as it's the trigger
      ]
    });

    const userMessage = cleanHistory[cleanHistory.length - 1].parts[0].text;
    const result = await chat.sendMessage(userMessage);
    const response = result.response;
    const calls = response.functionCalls();

    if (calls && calls.length > 0) {
      const call = calls[0];
      const host = event.headers.host || 'localhost:8888';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const toolUrl = `${protocol}://${host}/.netlify/functions/${call.name}`;

      const toolResponse = await fetch(toolUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.args)
      });

      const toolData = await toolResponse.json();

      // Send tool data back to AI
      const finalResult = await chat.sendMessage([{
        functionResponse: { name: call.name, response: toolData }
      }]);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: finalResult.response.text() })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: response.text() })
    };

  } catch (error: any) {
    console.error("AI CRASH LOG:", error);
    return {
      statusCode: 200, // Return 200 so the UI doesn't break, but send the error message
      headers,
      body: JSON.stringify({ reply: "క్షమించండి, నా మెదడులో చిన్న సమస్య వచ్చింది. దయచేసి మళ్ళీ ప్రయత్నించండి." })
    };
  }
};