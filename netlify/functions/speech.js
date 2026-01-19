exports.handler = async (event) => {
  // 1. Get the secret key from Netlify's settings (we will set this in Step 5)
  const apiKey = process.env.GOOGLE_TTS_API_KEY;

  // 2. The secret Google URL
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

  try {
    // 3. Get the text sent from your website
    const body = JSON.parse(event.body);

    // 4. Send that text to Google
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    // 5. Send Google's audio response back to your website
    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};