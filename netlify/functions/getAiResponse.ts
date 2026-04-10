import { Handler, HandlerEvent } from '@netlify/functions';

// --- CONSTANTS & CONFIGURATION ---
const MISTRAL_MODEL = "mistral-small-latest";
const DEFAULT_HOST = 'sahayhealth.netlify.app';

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

// --- TYPE DEFINITIONS ---
interface ChatPart { text: string; }
interface HistoryItem { role: 'user' | 'model'; parts: ChatPart[]; }
interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string; };
}

// --- TOOL DEFINITIONS ---
const tools = [
    {
        type: "function",
        function: {
            name: "getAvailableSlots",
            description: "Find availability. Use this ONLY after the user has specified a DATE.",
            parameters: {
                type: "object",
                properties: {
                    doctorName: { type: "string" },
                    date: { type: "string", description: "YYYY-MM-DD. Ask the user for this date." },
                    timeOfDay: { type: "string", enum: ["morning", "afternoon", "evening"] }
                },
                required: ["doctorName", "date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getDoctorDetails",
            description: "Search for doctors by name or specialty.",
            parameters: {
                type: "object",
                properties: { specialty: { type: "string" }, doctorName: { type: "string" } }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "rescheduleAppointment",
            description: "Reschedule an existing confirmed appointment to a new date and/or time. Call this once you have: patient name, doctor name, old appointment date, AND the new date and new time. Convert ALL dates to YYYY-MM-DD and ALL times to HH:MM (24-hour) format before calling. Example: '9 AM' becomes '09:00', '2 PM' becomes '14:00'.",
            parameters: {
                type: "object",
                properties: {
                    patientName: { type: "string", description: "The patient's full name." },
                    doctorName: { type: "string", description: "The doctor's name as known in the system." },
                    oldDate: { type: "string", description: "Original appointment date in YYYY-MM-DD format." },
                    newDate: { type: "string", description: "New desired date in YYYY-MM-DD format." },
                    newTime: { type: "string", description: "New desired time in HH:MM 24-hour format (e.g. '09:00', '14:30')." }
                },
                required: ["patientName", "doctorName", "oldDate"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "cancelAppointment",
            description: "Cancel a confirmed appointment. Call this as soon as you have the doctor's name, the patient's name, and the appointment date. Convert any natural language date (e.g. '7th April 2026', 'tomorrow') to YYYY-MM-DD format before calling.",
            parameters: {
                type: "object",
                properties: {
                    doctorName: { type: "string", description: "The doctor's name as known in the system." },
                    patientName: { type: "string", description: "The patient's full name." },
                    date: { type: "string", description: "The appointment date in YYYY-MM-DD format." }
                },
                required: ["doctorName", "patientName", "date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "bookAppointment",
            description: "FINAL STEP: Call this ONLY when you have Doctor, Date, Time, Patient Name, and Phone. Email is optional — pass it if the user provided one, or pass an empty string / 'skip' if they declined.",
            parameters: {
                type: "object",
                properties: {
                    doctorName: { type: "string" },
                    patientName: { type: "string" },
                    phone: { type: "string" },
                    date: { type: "string" },
                    time: { type: "string" },
                    email: { type: "string", description: "Patient's email address for sending the booking confirmation. Pass an empty string if the user said 'skip', 'no', or did not provide one." }
                },
                required: ["doctorName", "patientName", "phone", "date", "time"]
            }
        }
    }
];

async function executeTool(name: string, args: object, host: string): Promise<any> {
    try {
        const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : 'https';
        const sanitizedHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `${protocol}://${sanitizedHost}/.netlify/functions/${name}`;
        console.log(`[ORCHESTRATOR] Executing: ${name}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
        });
        return await response.json();
    } catch (err: any) {
        return { success: false, message: "Service busy." };
    }
}

export const handler: Handler = async (event: HandlerEvent) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        const apiKey = process.env.MISTRAL_API_KEY;
        const body = JSON.parse(event.body || '{}');
        const history: HistoryItem[] = body.history || [];
        const host = event.headers['x-forwarded-host'] || event.headers.host || DEFAULT_HOST;

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA');
        const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

        const messages = [
            {
                role: "system",
                content: `You are Sahay, the smart Medical Orchestrator. 
Today is ${dayOfWeek}, ${todayStr}.

STRICT BOOKING WORKFLOW (DO NOT SKIP STEPS):
1. SELECT DOCTOR: Suggest a doctor based on symptoms or name.
2. MANDATORY DATE REQUEST: Once the user agrees to a doctor, you MUST ask: "On which date would you like to book the appointment?"
3. LOCK DATE: DO NOT call 'getAvailableSlots' until the user provides a specific date (e.g., "Tomorrow", "January 26", or "25/01/2026").
4. SHOW PERIODS: After getting the date, call 'getAvailableSlots' for that specific date and show Morning/Afternoon/Evening options.
5. PICK SLOT: Show specific times and wait for the user to clearly pick one. If the user sends an incomplete message (e.g., "book an appointment on" without a time), ask them to specify the time. Do NOT move to the next step until a specific time slot is confirmed.
6. GATHER INFO (ONE AT A TIME, WITH CONFIRMATION):
   a. NAME: Ask: "May I have your full name for the booking?" Wait for the name. Then READ IT BACK: "I have your name as [name]. Is that correct?" If the user says no, wrong, or provides a correction, update the name and confirm again. Only proceed once the user confirms the name is correct.
   b. PHONE: Ask: "And your 10-digit mobile number, please?" Wait for the phone number. Then READ IT BACK: "I have your number as [number]. Is that correct?" If the user says no, wrong, or provides a correction, update the number and confirm again. Only proceed once the user confirms the number is correct.
   c. EMAIL (OPTIONAL): Ask: "Lastly, could I have your email address? We'll send your booking confirmation there. You can say 'skip' if you'd rather not share one." Wait for a response. If the user provides an email, READ IT BACK clearly (spelling out symbols, e.g. "ravi at gmail dot com") and ask "Is that correct?" — only proceed once the user confirms. If the user says "skip", "no", "don't have one", "not now", or anything similar, treat it as skipped: set email to empty string and move on without asking again. NEVER pressure the user to provide an email — it is optional.
   Do NOT ask for name, phone, and email in the same message. Do NOT guess or extract the name or email from unrelated sentences.
6a. PHONE HANDLING (MANDATORY): When the user provides a phone number, do NOT try to count digits or validate it yourself. Users may say numbers in groups like "63000 81436", "901 438 6804", "9 0 1 4 3 8 6 8 0 4", or as one block "9014386804" — ALL of these are the same valid number. Your job is to: (a) Take ALL the digits from the user's message, (b) Remove ALL spaces, dashes, and separators, (c) Concatenate them into a single continuous string, (d) Pass that cleaned string to the bookAppointment tool. The tool will validate the phone number and tell you if it is invalid. If the tool says it is invalid, relay that message to the user and ask again. NEVER reject a phone number yourself — always let the tool decide.
6b. EMAIL HANDLING: Users may say emails like "ravi at gmail dot com", "ravi@gmail.com", or "ravi underscore kumar at yahoo dot co dot in". Convert spoken forms to standard email format: "at" → "@", "dot" → ".", "underscore" → "_", "dash" or "hyphen" → "-". Strip ALL spaces. Pass the cleaned email to the bookAppointment tool. If the user clearly declines (says skip / no / none / don't have / not now), pass an empty string as the email — do NOT pass the word "skip" itself, pass "".
7. CONFIRM BEFORE BOOKING: Before calling the tool, summarize ALL details clearly and ask for confirmation. Say exactly: "Let me confirm your booking: Doctor: [name], Date: [date], Time: [time], Patient Name: [name], Phone: [phone], Email: [email or 'not provided']. Shall I go ahead and confirm this appointment?" Do NOT call 'bookAppointment' until the user says yes, confirm, proceed, or similar affirmation. CORRECTION AT SUMMARY: If the user says something like "wrong name", "change phone", "wrong email", "name is wrong", "that's not my name", or "my number is different", ask ONLY for the specific detail that needs correction. Do NOT re-ask for all details. After the user provides the corrected value, read back the updated summary again for confirmation.
8. FINALIZE: Only after the user explicitly confirms ALL details are correct, call 'bookAppointment' with all the verified details.

CANCELLATION WORKFLOW (DO NOT SKIP STEPS):
1. IDENTIFY INTENT: When a user says they want to cancel, ask for: Doctor name, Patient name, and Date of the appointment.
2. COLLECT ALL THREE: Do not proceed until you have all three details.
3. CONVERT DATE: Convert any natural date like "7th April 2026", "tomorrow", "next Monday" into YYYY-MM-DD format.
4. EXECUTE IMMEDIATELY: Once you have doctorName, patientName, and date in YYYY-MM-DD, call the 'cancelAppointment' tool right away. Do NOT say you lack the tools. Do NOT ask for confirmation again.
5. REPORT RESULT: Tell the user whether the cancellation succeeded or failed based on the tool response.

RESCHEDULING WORKFLOW (DO NOT SKIP STEPS):
1. IDENTIFY INTENT: When a user says they want to reschedule, ask for: Doctor name, Patient name, Old appointment date, New date, and New time.
2. COLLECT ALL FIVE: Do not call the tool until you have all five details. If the user provides some but not all, ask only for the missing ones.
3. CONVERT FORMATS: Convert ALL dates to YYYY-MM-DD format. Convert ALL times to HH:MM 24-hour format. Examples: "9 AM" = "09:00", "2:30 PM" = "14:30", "morning 10" = "10:00", "3 o'clock" = "15:00".
4. EXECUTE IMMEDIATELY: Once you have patientName, doctorName, oldDate, newDate, and newTime all in the correct format, call the 'rescheduleAppointment' tool right away. Do NOT say you lack tools.
5. REPORT RESULT: Tell the user whether the reschedule succeeded or failed based on the tool response. Include the new date and time in the confirmation.

RULES:
- NEVER assume a date. Always ask the user first.
- Convert natural dates like "tomorrow" or "7th April 2026" to YYYY-MM-DD before calling ANY tool.
- Convert times like "9 AM", "2:30 PM", "morning 10 o'clock" to HH:MM 24-hour format before calling ANY tool.
- If the user provides a date that is in the past (before today ${todayStr}), do NOT say you lack tools or cannot help. Simply tell them: "That date has already passed. Could you please provide a future date?" and continue the workflow.
- NO ASTERISKS (**). Plain text only. Friendly and professional.
- When you have all required parameters for a tool, CALL IT IMMEDIATELY. Never say you cannot help.
- NEVER guess or assume the patient's name or phone number. Only use what the user explicitly provides in response to your direct question.
- If the user provides partial or unclear information, ask a clarifying follow-up question instead of guessing.
- REMEMBER WHAT THE USER ALREADY TOLD YOU. If the user provides multiple details in one message (e.g., doctor name + date) and one part is invalid (e.g., past date or wrong doctor name), acknowledge and keep the valid parts. Only ask them to correct what was wrong. Never re-ask for information the user has already provided correctly earlier in the conversation.`
            },
            ...history.map(item => ({
                role: item.role === 'model' ? 'assistant' : 'user',
                content: item.parts[0].text
            }))
        ];

        // Pass 1: Reasoning
        const firstResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MISTRAL_MODEL,
                messages: messages,
                tools: tools,
                tool_choice: "auto",
                temperature: 0.1
            })
        });

        const firstData: any = await firstResponse.json();

        if (!firstData?.choices?.[0]?.message) {
            console.error('[ORCHESTRATOR] Pass-1 Mistral error:', JSON.stringify(firstData));
            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify({
                    reply: "I'm having trouble reaching my brain right now. Could you please repeat that?",
                    endCall: false
                })
            };
        }

        let aiMessage = firstData.choices[0].message;

        // Pass 2: Tool Execution
        let endCall = false;
        if (aiMessage.tool_calls) {
            const toolResults = [];
            const TERMINAL_TOOLS = ['bookAppointment', 'cancelAppointment', 'rescheduleAppointment'];
            for (const toolCall of aiMessage.tool_calls as ToolCall[]) {
                let parsedArgs: object = {};
                try {
                    parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
                } catch (parseErr: any) {
                    console.error(`[ORCHESTRATOR] Bad tool args for ${toolCall.function.name}:`, toolCall.function.arguments, parseErr?.message);
                    toolResults.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                        content: JSON.stringify({ success: false, message: "Invalid tool arguments. Please rephrase the request." })
                    });
                    continue;
                }

                const result = await executeTool(toolCall.function.name, parsedArgs, host);
                // Auto-end call when a terminal action succeeds
                if (TERMINAL_TOOLS.includes(toolCall.function.name) && result?.success) {
                    endCall = true;
                }
                toolResults.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: JSON.stringify(result)
                });
            }

            const finalResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: MISTRAL_MODEL,
                    messages: [...messages, aiMessage, ...toolResults],
                    temperature: 0.7
                })
            });

            const finalData: any = await finalResponse.json();

            if (!finalData?.choices?.[0]?.message) {
                console.error('[ORCHESTRATOR] Pass-2 Mistral error:', JSON.stringify(finalData));
                return {
                    statusCode: 200,
                    headers: HEADERS,
                    body: JSON.stringify({
                        reply: "I processed your request but had trouble forming a reply. Could you please confirm that again?",
                        endCall
                    })
                };
            }

            aiMessage = finalData.choices[0].message;
        }

        const replyText = (aiMessage.content || "").replace(/\*\*/g, "").trim();

        // Mistral occasionally returns an empty content string (especially
        // when tool_calls finish without producing follow-up text). Surface
        // a friendly fallback instead of letting the frontend show
        // "I apologize, I couldn't retrieve a response".
        const safeReply = replyText || "Could you please repeat that?";

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ reply: safeReply, endCall })
        };

    } catch (error: any) {
        console.error('[ORCHESTRATOR] Unhandled error:', error?.message, error?.stack);
        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                reply: "Sorry, I hit an unexpected issue. Could you please try that again?",
                endCall: false
            })
        };
    }
};