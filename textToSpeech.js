const fetch = require('node-fetch');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const { text } = JSON.parse(event.body);

    // We use ElevenLabs Multilingual v2 (it speaks Telugu perfectly!)
    const url = "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4lpxqxtnmHUC"; // "Rachel" voice

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.5 }
      })
    });

    if (!response.ok) throw new Error("ElevenLabs API failed");

    // Get the audio data as a buffer
    const audioBuffer = await response.buffer();
    const base64Audio = audioBuffer.toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioContent: base64Audio })
    };
  } catch (error) {
    console.error("Voice Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};