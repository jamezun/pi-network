// Pi Network — ULID message ID generator
// Stolen from coms.ts: time-sortable, 26-char Crockford Base32 identifiers.
// Better than random IDs for debugging/sorting agent messages.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32
const ENCODING_LEN = ENCODING.length;
const TIME_MAX = Math.pow(2, 48) - 1;

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    now = (now - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len: number): string {
  let str = "";
  const randomBytes = new Uint8Array(len);
  // Use crypto.getRandomValues if available, else Math.random
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < len; i++) randomBytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < len; i++) {
    str += ENCODING.charAt(randomBytes[i] % ENCODING_LEN);
  }
  return str;
}

/**
 * Generate a ULID — 26 chars, time-sortable, Crockford Base32.
 * Format: 10-char timestamp + 16-char random.
 */
export function ulid(): string {
  const now = Date.now();
  if (now > TIME_MAX) throw new Error("Cannot generate ULID for times after 10889-08-02");
  return encodeTime(now, 10) + encodeRandom(16);
}
