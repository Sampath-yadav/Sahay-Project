import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import fetch from 'node-fetch';

const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS Pre-flight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is missing in environment variables.");
    }

    // Safely parse the incoming text
    const body = JSON.parse(event.body || '{}');
    const { text } = body;

    if (!text) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "No text provided for speech synthesis." }) 
      };
    }

    // ElevenLabs Configuration
    // Voice ID: 21m00Tcm4lpxqxtnmHUC (Rachel)
    const voiceId = "21m00Tcm4lpxqxtnmHUC";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { 
          stability: 0.5, 
          similarity_boost: 0.5 
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("ElevenLabs API Error:", errorData);
      throw new Error(`ElevenLabs API failed with status ${response.status}`);
    }

    // Convert audio binary data to Base64 string for easy transport
    const audioBuffer = await response.buffer();
    const base64Audio = audioBuffer.toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioContent: base64Audio })
    };

  } catch (error: any) {
    console.error("TypeScript Voice Error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

export { handler };