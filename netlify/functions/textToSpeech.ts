import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';

/**
 * Optimized Sanitizer: 
 * Ensures the text is clean for ElevenLabs Multilingual v2.
 * This helps in maintaining a native Telugu flow.
 */
const sanitizeForTeluguTTS = (text: string): string => {
  return text
    .replace(/[#*`]/g, '')        // Remove markdown symbols
    .replace(/(\d+)\s*-\s*(\d+)/g, '$1 నుండి $2') // Convert "10-11" to "10 నుండి 11"
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
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY missing.");

    const body = JSON.parse(event.body || '{}');
    let { text } = body;

    if (!text) return { statusCode: 400, headers, body: JSON.stringify({ error: "No text." }) };

    // Optimize text for Telugu native flow
    text = sanitizeForTeluguTTS(text);

    // Voice ID: QeKcckTBICc3UuWL7ETc
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
        model_id: "eleven_multilingual_v2", // Best for regional Indian languages
        voice_settings: { 
          stability: 0.38,           // Perfect balance for "Human-like" variance
          similarity_boost: 0.85,    // High boost to lock in the native Telugu accent
          style: 0.1,                // Adds a slight professional cadence
          use_speaker_boost: true    // Enhances clarity for mobile speakers
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`ElevenLabs Error: ${errorData.detail?.status || response.statusText}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioContent: base64Audio })
    };

  } catch (error: any) {
    console.error("Optimized Voice Error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

export { handler };