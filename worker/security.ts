export function normalizeRecoveryEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function maskRecoveryEmail(value: string): string {
  const [local = "", domain = ""] = normalizeRecoveryEmail(value).split("@");
  if (!local || !domain) return "••••";
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

export function isValidRecoveryEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeRecoveryEmail(value));
}

export function isRecent(timestamp: string | null | undefined, windowMs: number, now = Date.now()): boolean {
  if (!timestamp) return false;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) && now - time < windowMs;
}

export function isStrongPassword(value: string): boolean {
  return value.length >= 12 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

export function recoveryCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}
