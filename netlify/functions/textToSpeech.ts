const fetch = require('node-fetch');

exports.handler = async (event) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { text } = JSON.parse(event.body);
    const apiKey = process.env.GOOGLE_TTS_API_KEY;

    if (!apiKey) {
      throw new Error("Google TTS API Key is missing in Netlify settings.");
    }

    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { 
          languageCode: 'te-IN', 
          name: 'te-IN-Standard-A', // High quality Telugu voice
          ssmlGender: 'FEMALE' 
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
  } catch (error) {
    console.error("TTS Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};