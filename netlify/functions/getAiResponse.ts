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
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'CORS preflight successful' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "AI configuration error." }) };
  }

  const body = JSON.parse(event.body || '{}');
  const { history } = body;

  if (!history || !Array.isArray(history)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No history provided." }) };
  }

  const todayStr = getFormattedDate(new Date());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = getFormattedDate(tomorrow);

  // --- SYSTEM PROMPT (The Sahay Personality) ---
  const systemPrompt = `
    You are Sahay, a helpful AI medical assistant for Prudence Hospitals.
    
    **MANDATORY: ALWAYS SPEAK IN TELUGU.**
    
    Internal Context:
    - Today is ${todayStr}.
    - Tomorrow is ${tomorrowStr}.
    
    Workflow:
    1. Greet the user in Telugu.
    2. Identify symptoms or the required specialty.
    3. Use 'getDoctorDetails' to find matching doctors.
    4. Ask the user to confirm a specific doctor.
    5. Check 'getAvailableSlots' for the chosen date.
    6. Collect patient name and phone number.
    7. Use 'bookAppointment' for the final transaction.
    
    Rules:
    - Silently convert natural dates (like "tomorrow") to YYYY-MM-DD for tool calls.
    - Never mention technical date formats to the user.
    - Confirm all details before booking.
  `;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tools: [{
        functionDeclarations: [
          {
            name: "getAllSpecialties",
            description: "Gets all clinical specialties available at Prudence Hospitals."
          },
          {
            name: "getDoctorDetails",
            description: "Finds doctors by name or specialty.",
            parameters: {
              type: "OBJECT",
              properties: {
                doctorName: { type: "STRING" },
                specialty: { type: "STRING" }
              }
            }
          },
          {
            name: "getAvailableSlots",
            description: "Checks availability for a specific doctor and date.",
            parameters: {
              type: "OBJECT",
              properties: {
                doctorName: { type: "STRING" },
                date: { type: "STRING", description: "Format: YYYY-MM-DD" },
                timeOfDay: { type: "STRING", enum: ["morning", "afternoon", "evening"] }
              },
              required: ["doctorName", "date"]
            }
          },
          {
            name: "bookAppointment",
            description: "Executes the final appointment booking.",
            parameters: {
              type: "OBJECT",
              properties: {
                doctorName: { type: "STRING" },
                patientName: { type: "STRING" },
                phone: { type: "STRING" },
                date: { type: "STRING" },
                time: { type: "STRING" }
              },
              required: ["doctorName", "patientName", "phone", "date", "time"]
            }
          }
        ]
      }]
    });

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "అర్థమైంది. నేను సహాయ్ గా తెలుగులో మీకు సహాయం చేస్తాను." }] },
        ...history.slice(0, -1)
      ]
    });

    const userMessage = history[history.length - 1].parts[0].text;
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

      // Send the tool data back to the LLM to get the final Telugu response
      const finalResult = await chat.sendMessage([{
        functionResponse: {
          name: call.name,
          response: toolData
        }
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
    console.error("Gemini Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "I'm having trouble thinking in Telugu right now. Please try again." })
    };
  }
};