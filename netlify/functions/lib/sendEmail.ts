// netlify/functions/lib/sendEmail.ts
//
// Tiny Resend wrapper. Sends a single transactional email via the Resend
// REST API. Best-effort: never throws — callers can rely on the returned
// { ok } flag and keep their primary flow (e.g. appointment booking)
// unaffected by email failures.
//
// Free tier: 3000 emails/month, 100/day, no credit card required.
// For new Resend accounts you can use `onboarding@resend.dev` as the
// `from` address (the value of RESEND_FROM_EMAIL) without verifying a
// domain. For real production, verify a domain in the Resend dashboard
// and set RESEND_FROM_EMAIL to something like "Medicall <noreply@yourdomain.com>".

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendEmailResult {
    ok: boolean;
    error?: string;
}

export interface SendEmailArgs {
    to: string;
    subject: string;
    html: string;
    text: string;
}

// RFC-5322-lite. Good enough to catch typos; Resend will reject anything
// that's actually undeliverable.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (email: string): boolean =>
    typeof email === 'string' && EMAIL_RE.test(email.trim());

export const sendEmail = async ({ to, subject, html, text }: SendEmailArgs): Promise<SendEmailResult> => {
    const apiKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.RESEND_FROM_EMAIL || 'Medicall <onboarding@resend.dev>';

    if (!apiKey) {
        console.error('[EMAIL] RESEND_API_KEY is not set — skipping email send.');
        return { ok: false, error: 'missing_api_key' };
    }

    if (!isValidEmail(to)) {
        console.error(`[EMAIL] Invalid recipient "${to}" — skipping send.`);
        return { ok: false, error: 'invalid_email' };
    }

    try {
        const res = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: fromAddress,
                to: [to.trim()],
                subject,
                html,
                text
            })
        });

        const data: any = await res.json().catch(() => ({}));

        if (res.ok && data?.id) {
            console.log(`[EMAIL] Sent to ${to} (id=${data.id})`);
            return { ok: true };
        }

        console.error(`[EMAIL] Resend HTTP ${res.status}:`, data);
        return { ok: false, error: data?.message || data?.name || `http_${res.status}` };
    } catch (err: any) {
        console.error('[EMAIL] Network/exception:', err?.message || err);
        return { ok: false, error: 'network_error' };
    }
};

/**
 * Build the appointment confirmation email body (HTML + plain-text fallback).
 * Pure function — kept here so the bookAppointment handler stays focused on
 * orchestration rather than templating.
 */
export const buildAppointmentEmail = (args: {
    patientName: string;
    doctorName: string;
    date: string;
    time: string;
}): { subject: string; html: string; text: string } => {
    const { patientName, doctorName, date, time } = args;

    const subject = `Appointment Confirmed — Dr. ${doctorName} on ${date}`;

    const text =
        `Hi ${patientName},\n\n` +
        `Your appointment has been confirmed.\n\n` +
        `Doctor: Dr. ${doctorName}\n` +
        `Date: ${date}\n` +
        `Time: ${time}\n\n` +
        `Please arrive 10 minutes early. To reschedule or cancel, reply to this email or call us back.\n\n` +
        `— Medicall Health`;

    const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #222;">
  <div style="border: 1px solid #e5e5e5; border-radius: 8px; padding: 24px; background: #ffffff;">
    <h2 style="margin: 0 0 8px 0; color: #2c5aa0;">Appointment Confirmed</h2>
    <p style="margin: 0 0 16px 0; color: #555;">Hi <strong>${patientName}</strong>, your appointment has been successfully booked.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 8px 0 20px 0;">
      <tr>
        <td style="padding: 10px 12px; background: #f5f7fa; border: 1px solid #e5e5e5; width: 110px;"><strong>Doctor</strong></td>
        <td style="padding: 10px 12px; border: 1px solid #e5e5e5;">Dr. ${doctorName}</td>
      </tr>
      <tr>
        <td style="padding: 10px 12px; background: #f5f7fa; border: 1px solid #e5e5e5;"><strong>Date</strong></td>
        <td style="padding: 10px 12px; border: 1px solid #e5e5e5;">${date}</td>
      </tr>
      <tr>
        <td style="padding: 10px 12px; background: #f5f7fa; border: 1px solid #e5e5e5;"><strong>Time</strong></td>
        <td style="padding: 10px 12px; border: 1px solid #e5e5e5;">${time}</td>
      </tr>
    </table>
    <p style="margin: 0 0 8px 0; font-size: 14px; color: #555;">Please arrive 10 minutes early. To reschedule or cancel, reply to this email or call us back.</p>
  </div>
  <p style="text-align: center; color: #999; font-size: 12px; margin-top: 16px;">— Medicall Health</p>
</div>`.trim();

    return { subject, html, text };
};
