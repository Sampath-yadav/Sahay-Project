import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';

/**
 * Clean Text for TTS:
 * Removes unnecessary symbols to ensure a smooth English flow
 * without robotic pauses.
 */
const cleanEnglishText = (text: string): string => {
  return text
    .replace(/[#*`]/g, '') // Remove markdown formatting
    .replace(/\s+/g, ' ')  // Normalize whitespace
    .trim();
};

const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY missing in environment variables.");

    const body = JSON.parse(event.body || '{}');
    let { text } = body;

    if (!text) return { statusCode: 400, headers, body: JSON.stringify({ error: "No text provided." }) };

    // Prepare text for English synthesis
    text = cleanEnglishText(text);

    // Voice ID: EXAVITQu4vr4xnSDxMaL (Sarah - Professional English)
    const voiceId = "QeKcckTBICc3UuWL7Tc";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_turbo_v2_5", // Optimized for English (Fast & Accurate)
        voice_settings: { 
          stability: 0.5,           // Balanced for professional consistency
          similarity_boost: 0.75,    // High clarity for English pronunciation
          style: 0.0,                // Neutral, professional tone
          use_speaker_boost: true    // Enhances voice presence
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`ElevenLabs API Error: ${errorData.detail?.status || response.statusText}`);
    }

    // Convert audio binary to Base64 for the frontend
    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioContent: base64Audio })
    };

  } catch (error: any) {
    console.error("English Voice Service Error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Voice synthesis failed", details: error.message })
    };
  }
};

export { handler };