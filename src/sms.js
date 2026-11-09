// Sending sign-in codes.
//
// Development (the default outside production): nothing is sent; the API returns the code so the screen can
// show it, which is what the demo accounts rely on.
// Production (NODE_ENV=production, or DEV_CODES=0): codes are never returned to the browser. They go to an SMS
// or WhatsApp gateway configured by environment variables:
//   SMS_GATEWAY_URL    the gateway endpoint; it receives POST JSON { to, channel, text }
//   SMS_GATEWAY_TOKEN  sent as "Authorization: Bearer <token>"
// Without a gateway, sign-in refuses to start rather than pretending a code was sent.

export const devCodes = () => {
  if (process.env.DEV_CODES === '1') return true;
  if (process.env.DEV_CODES === '0') return false;
  return process.env.NODE_ENV !== 'production';
};

export class CodeDeliveryError extends Error {}

export async function sendCode(phone, code, channel) {
  if (devCodes()) return { dev: true };
  const url = process.env.SMS_GATEWAY_URL;
  if (!url) throw new CodeDeliveryError('Sign-in codes cannot be sent yet. Contact the Kainat team.');
  const to = '+92' + phone.replace(/^0/, '');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.SMS_GATEWAY_TOKEN ? { Authorization: `Bearer ${process.env.SMS_GATEWAY_TOKEN}` } : {}) },
      body: JSON.stringify({ to, channel, text: `Your Kainat code is ${code}. It expires in 10 minutes. Never share it with anyone.` }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new CodeDeliveryError('We could not send your code. Try again in a minute.');
  }
  if (!res.ok) throw new CodeDeliveryError('We could not send your code. Try again in a minute.');
  return { dev: false };
}
