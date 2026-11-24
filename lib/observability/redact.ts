/**
 * Redaction for anything stored in traces or shown in the drawer: secrets are removed, emails
 * are masked, PINs (6-digit numbers) are hidden. Applied recursively to JSON values.
 */
const SECRET = /\b(sk-[A-Za-z0-9_-]{8,}|ek_[A-Za-z0-9]{6,}|postgres(?:ql)?:\/\/\S+)/g;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const PIN = /(?<![\d$])\d{6}(?!\d|[.,]\d)/g;

export function redactText(s: string): string {
  return s.replace(SECRET, "[secret]").replace(EMAIL, "$1***@$2").replace(PIN, "[pin]");
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /^(pin|support_pin|password|apiKey|api_key|clientSecret|value)$/i.test(k) && typeof v === "string" ? "[redacted]" : redact(v);
    }
    return out as T;
  }
  return value;
}
