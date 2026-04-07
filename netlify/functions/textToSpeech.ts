import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';

/**
 * Clean Text for TTS:
 * Removes unnecessary symbols to ensure a smooth English flow
 * without robotic pauses.
 */
const cleanEnglishText = (text: string): string => {
    return text
        .replace(/[#*`]/g, '')
        .replace(/\s+/g, ' ')
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

    // ──────────────────────────────────────────────
    // NEW: Health check — GET request returns config status
    // Test with: curl https://yoursite/.netlify/functions/textToSpeech
    // ──────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const apiKey = process.env.ELEVENLABS_API_KEY || '';
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: 'ok',
                hasApiKey: apiKey.length > 0,
                keyPrefix: apiKey.substring(0, 6) + '...',
                keyLength: apiKey.length
            })
        };
    }

    try {
        // ──────────────────────────────────────────────
        // FIX: Validate API key before making the call
        // Catches empty, whitespace-only, or quote-wrapped keys
        // ──────────────────────────────────────────────
        const rawKey = process.env.ELEVENLABS_API_KEY || '';
        const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

        if (!apiKey) {
            console.error("[TTS] ELEVENLABS_API_KEY is missing or empty");
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    error: "Voice service not configured",
                    details: "ELEVENLABS_API_KEY environment variable is missing."
                })
            };
        }

        if (apiKey.length < 20) {
            console.error(`[TTS] API key looks invalid (length: ${apiKey.length})`);
            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    error: "Voice service misconfigured",
                    details: "API key appears too short. Check Netlify environment variables."
                })
            };
        }

        const body = JSON.parse(event.body || '{}');
        let { text } = body;

        if (!text) return { statusCode: 200, headers, body: JSON.stringify({ error: "No text provided." }) };

        text = cleanEnglishText(text);

        // Voice ID — verified from ElevenLabs dashboard
        const voiceId = "QeKcckTBICc3UuWL7ETc";
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

        // ──────────────────────────────────────────────
        // FIX: Model fallback chain
        // Try turbo first (fastest), fall back to multilingual v2
        // if turbo is unavailable on the user's plan.
        // ──────────────────────────────────────────────
        const models = ["eleven_turbo_v2_5", "eleven_multilingual_v2"];
        let lastError = '';

        for (const modelId of models) {
            console.log(`[TTS] Trying model: ${modelId}, voice: ${voiceId}`);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'xi-api-key': apiKey,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        text: text,
                        model_id: modelId,
                        voice_settings: {
                            stability: 0.5,
                            similarity_boost: 0.75,
                            style: 0.0,
                            use_speaker_boost: true
                        }
                    })
                });

                // ──────────────────────────────────────────────
                // FIX: Detailed error parsing per status code
                // ──────────────────────────────────────────────
                if (!response.ok) {
                    let errorDetail = '';
                    try {
                        const errBody = await response.text();
                        errorDetail = errBody;
                        const errJson = JSON.parse(errBody);
                        errorDetail = errJson.detail?.message || errJson.detail?.status || errJson.detail || errBody;
                    } catch { }

                    const errMsg = `Model ${modelId}: HTTP ${response.status} — ${errorDetail}`;
                    console.error(`[TTS] ${errMsg}`);

                    // 401 = bad API key — no point trying other models
                    if (response.status === 401) {
                        return {
                            statusCode: 200, headers,
                            body: JSON.stringify({
                                error: "Voice authentication failed",
                                details: "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in Netlify environment variables.",
                                status: 401
                            })
                        };
                    }

                    // 404 = voice not found — no point trying other models
                    if (response.status === 404) {
                        return {
                            statusCode: 200, headers,
                            body: JSON.stringify({
                                error: "Voice not found",
                                details: `Voice ID '${voiceId}' was not found. It may have been deleted or is not accessible with this API key.`,
                                status: 404
                            })
                        };
                    }

                    // 400/422 = model issue — try next model
                    lastError = errMsg;
                    continue;
                }

                // Success — convert to base64
                const audioBuffer = await response.arrayBuffer();

                if (audioBuffer.byteLength === 0) {
                    console.error("[TTS] Received empty audio buffer");
                    lastError = `Model ${modelId}: Empty response`;
                    continue;
                }

                const base64Audio = Buffer.from(audioBuffer).toString('base64');
                console.log(`[TTS] Success with model ${modelId}, audio size: ${audioBuffer.byteLength} bytes`);

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ audioContent: base64Audio })
                };

            } catch (fetchError: any) {
                // ──────────────────────────────────────────────
                // FIX: Catch network-level errors (DNS, timeout, blocked)
                // This is where the egress proxy block would surface.
                // ──────────────────────────────────────────────
                const networkMsg = fetchError.message || 'Unknown network error';
                console.error(`[TTS] Network error with model ${modelId}: ${networkMsg}`);

                // If it's a network error, no point trying other models
                if (networkMsg.includes('ENOTFOUND') || networkMsg.includes('ECONNREFUSED') ||
                    networkMsg.includes('fetch failed') || networkMsg.includes('network')) {
                    return {
                        statusCode: 200, headers,
                        body: JSON.stringify({
                            error: "Cannot reach ElevenLabs",
                            details: `Network error: ${networkMsg}. Ensure 'api.elevenlabs.io' is in your Netlify allowed domains.`,
                            networkBlocked: true
                        })
                    };
                }

                lastError = networkMsg;
                continue;
            }
        }

        // All models failed
        return {
            statusCode: 200, headers,
            body: JSON.stringify({
                error: "Voice synthesis failed",
                details: `All models failed. Last error: ${lastError}`
            })
        };

    } catch (error: any) {
        console.error("[TTS_CRITICAL]:", error.message);
        return {
            statusCode: 200, headers,
            body: JSON.stringify({ error: "Voice synthesis failed", details: error.message })
        };
    }
};

export { handler };