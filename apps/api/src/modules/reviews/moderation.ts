/**
 * BR-REVIEW-004: review text is cleaned on submit — phone numbers and e-mail
 * addresses are removed and common profanity is masked. A small built-in list;
 * an admin-managed list and a moderation provider are CORE.
 */
const PROFANITY = [
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'chutiya',
  'madarchod',
  'bhenchod',
  'behenchod',
  'harami',
  'gandu',
];
const WORDS = new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'gi');
// Indian mobile numbers with optional +91/0 prefix and separators, and longer digit runs.
const PHONE = /(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}\b|\b\d(?:[\s-]?\d){9,}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function moderateText(text: string): { text: string; changed: boolean } {
  const cleaned = text
    .replace(EMAIL, '[removed]')
    .replace(PHONE, '[removed]')
    .replace(WORDS, (w) => `${w[0]}${'*'.repeat(w.length - 1)}`)
    .replace(/\s+/g, ' ')
    .trim();
  return { text: cleaned, changed: cleaned !== text.replace(/\s+/g, ' ').trim() };
}
