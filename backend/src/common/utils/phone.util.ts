/** Invalid/empty/unsupported recipient phone — non-retryable (skip + warn). */
export class InvalidPhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Normalize an Indonesian MSISDN to Qontak/WhatsApp form (`628xxxxxxxx`):
 *   08xxxxxxxx → 628xxxxxxxx · +628xxx → 628xxx · 628xxx → 628xxx
 * Throws InvalidPhoneError on empty / non-numeric / unsupported input.
 */
export function normalizePhoneNumber(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) {
    throw new InvalidPhoneError('phone number is empty');
  }
  // Keep digits only (drop spaces, dashes, parentheses, leading +).
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) {
    throw new InvalidPhoneError(`phone number has no digits: "${raw}"`);
  }

  let msisdn: string;
  if (digits.startsWith('62')) {
    msisdn = digits;
  } else if (digits.startsWith('0')) {
    msisdn = `62${digits.slice(1)}`;
  } else if (digits.startsWith('8')) {
    msisdn = `62${digits}`;
  } else {
    throw new InvalidPhoneError(`unsupported phone format: "${raw}"`);
  }

  // 62 + 9..13 subscriber digits (Indonesian mobile range).
  if (msisdn.length < 11 || msisdn.length > 15) {
    throw new InvalidPhoneError(`phone number length out of range: "${raw}"`);
  }
  return msisdn;
}

/**
 * Normalize an Indonesian MOBILE number to the canonical `628…` form.
 *
 * Stricter than `normalizePhoneNumber`, which is deliberately left as-is: it is
 * the general MSISDN normalizer the notification stack already depends on, and it
 * accepts any Indonesian number — a Jakarta landline `0211234567` normalizes to
 * `62211234567` quite happily.
 *
 * The ADDRESS phone is different (PAXELBOX-61AG.3.20). It is the number a courier
 * calls on delivery and the WhatsApp recipient Mekari Qontak messages, so a
 * landline there is not merely untidy — it silently breaks the notification. This
 * adds the one rule that distinguishes them: an Indonesian mobile MSISDN always
 * begins `628`.
 *
 * Composition, not duplication: prefix/digit/length handling stays in
 * `normalizePhoneNumber`, and this narrows the result.
 *
 * Accepts `08…`, `62…`, `+62…`, `8…`, with spaces, hyphens or parentheses.
 * Returns digits only. Throws InvalidPhoneError on anything else.
 */
export function normalizeIndonesianMobile(raw: string | null | undefined): string {
  const msisdn = normalizePhoneNumber(raw);
  if (!msisdn.startsWith('628')) {
    // Never echo the input: this value reaches logs and validation messages.
    throw new InvalidPhoneError('not an Indonesian mobile number (must start 08/62 8/+62 8)');
  }
  return msisdn;
}

/** True when `raw` is an Indonesian mobile number. Never throws. */
export function isIndonesianMobile(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    normalizeIndonesianMobile(raw);
    return true;
  } catch {
    return false;
  }
}

/** Mask a normalized phone for logs: 628****1234. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '***';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
