import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import fetch from 'node-fetch';

const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // 1. Handle Browser Security Check
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is missing in Netlify environment variables.");
    }

    const body = JSON.parse(event.body || '{}');
    const { text } = body;

    if (!text) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "No text provided." }) 
      };
    }

    // 2. ElevenLabs Configuration
    // Your updated Voice ID: QeKcckTBICc3UuWL7ETc
    const voiceId = "QeKcckTBICc3UuWL7ETc";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        // Using Multilingual v2 is the most important part for Telugu fluency
        model_id: "eleven_multilingual_v2",
        voice_settings: { 
          stability: 0.4,           // Lowered for more natural expression
          similarity_boost: 0.8,    // Increased for better regional accent
          style: 0.0,               // Standard style
          use_speaker_boost: true   // Makes the voice clearer
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("ElevenLabs API Error:", errorData);
      throw new Error(`ElevenLabs API failed: ${errorData.detail?.status || response.statusText}`);
    }

    // 3. Process the Audio Buffer
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