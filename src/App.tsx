// Define the function that calls your NEW Netlify endpoint
const convertTextToSpeech = async (textToSay: string) => {
  try {
    // We call YOUR server, not Google directly
    const response = await fetch('/.netlify/functions/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { text: textToSay },
        voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
        audioConfig: { audioEncoding: "MP3" },
      }),
    });

    const data = await response.json();

    if (data.audioContent) {
      // Create an audio player from the response
      const audio = new Audio(`data:audio/mp3;base64,${data.audioContent}`);
      audio.play();
    }
  } catch (error) {
    console.error("Error calling speech function:", error);
  }
};
