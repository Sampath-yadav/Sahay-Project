import { GoogleAuth } from 'google-auth-library';
import { Handler } from '@netlify/functions';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  // 1. Configuration Check
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: "Google Service Account key is not configured." }) 
    };
  }

  try {
    const { text } = JSON.parse(event.body || '{}');
    if (!text) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "No text provided to synthesize." }) 
      };
    }

    // 2. Authenticate with Google Cloud
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://texttospeech.googleapis.com/v1/text:synthesize`;

    // 3. Construct the Request (Enforcing Telugu Voice)
    const requestBody = {
      input: { text },
      voice: {
        languageCode: 'te-IN',
        name: 'te-IN-Standard-A' // Natural Telugu voice
      },
      audioConfig: {
        audioEncoding: 'MP3',
        pitch: 0,
        speakingRate: 1.0
      }
    };

    const ttsResponse = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken.token}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!ttsResponse.ok) {
      const errorDetails = await ttsResponse.json();
      throw new Error(`Google TTS API error: ${JSON.stringify(errorDetails)}`);
    }

    const ttsData = await ttsResponse.json();
    
    // 4. Return the Base64 audio content to the frontend
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioContent: ttsData.audioContent })
    };

  } catch (error: any) {
    console.error("TTS Error:", error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: error.message }) 
    };
  }
};