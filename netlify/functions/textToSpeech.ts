import { Handler } from '@netlify/functions';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { text } = JSON.parse(event.body || '{}');
  const apiKey = process.env.GOOGLE_API_KEY; // This is where your new key goes

  if (!text) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No text provided" }) };
  }

  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Google API Key missing in Netlify" }) };
  }

  try {
    // We use the REST API directly because it's faster and works better with a simple API Key
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { 
          languageCode: 'te-IN', 
          name: 'te-IN-Standard-A' // Telugu Female Voice
        },
        audioConfig: { audioEncoding: 'MP3' }
      })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioContent: data.audioContent })
    };

  } catch (error: any) {
    console.error("TTS Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to generate voice", details: error.message })
    };
  }
};