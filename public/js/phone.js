// Phone-number detection, shared by the server (which blocks numbers) and the screens (which warn while typing).
// Catches Pakistani mobiles (03xx xxxxxxx, +92 3xx…, 0092…, 3xx… without the 0), landlines (042 xxxxxxxx),
// numbers broken up with spaces, dashes, dots or brackets, Urdu and Arabic digits, and WhatsApp links.
// Prices ("Rs 325,000", "325000 8 20"), quantities and order numbers never match.

export const toLatin = (s) => String(s ?? '')
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

const RUN = () => /\+?[0-9][0-9\s\-.()]{8,}[0-9]/g;
const LINK = () => /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/\S*/gi;

// A run of digits is a phone number if it is a mobile (with or without 0 / 92, even joined to other digits) or a landline.
export const isPhoneDigits = (d) => d.length >= 10 && (/^3\d{9}$/.test(d) || /(?:0|92)3\d{9}/.test(d) || /^(?:92|0092|0)[1-9]\d{8,9}$/.test(d));

export function phoneIn(text) {
  const t = toLatin(text);
  if (LINK().test(t)) return true;
  return (t.match(RUN()) || []).some((run) => isPhoneDigits(run.replace(/\D/g, '')));
}

// The text with every phone number and WhatsApp link replaced by a placeholder.
export function maskPhones(text, placeholder = '[number hidden]') {
  // Links first: a WhatsApp link contains a number, and hiding the number first would leave half a link behind.
  return toLatin(text)
    .replace(LINK(), placeholder)
    .replace(RUN(), (run) => (isPhoneDigits(run.replace(/\D/g, '')) ? placeholder : run));
}
