export type JobClaim = {
  id: string;
  status: string;
  locked_at: string | null;
  available_at: string;
  attempts: number;
};

export function mailboxAcceptsInbound(mailbox: { status?: string; can_receive?: boolean } | null | undefined): boolean {
  return Boolean(mailbox && mailbox.status !== "disabled" && mailbox.can_receive !== false);
}

export function canClaimJob(job: JobClaim, now = Date.now()): boolean {
  if (job.status === "succeeded" || job.status === "cancelled") return false;
  if (job.status === "queued" && Date.parse(job.available_at) <= now) return true;
  if (job.status === "running" && job.locked_at && now - Date.parse(job.locked_at) > 5 * 60 * 1000) return true;
  return false;
}

export function nextRetryAt(attempts: number, now = Date.now()): Date {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts));
  return new Date(now + minutes * 60 * 1000);
}

export function inboundIdempotencyKey(mailboxId: string, messageIdHeader: string): string {
  return `${mailboxId}:${messageIdHeader.trim().toLowerCase()}`;
}

export function webhookEventId(provider: string, providerEventId: string): string {
  return `${provider}:${providerEventId}`;
}

export function objectKeyAllowed(ownerId: string, organizationId: string | null, objectKey: string): boolean {
  const prefixes = [
    `drafts/${ownerId}/`,
    `attachments/${ownerId}/`,
    `raw/${ownerId}/`,
  ];
  if (organizationId) {
    prefixes.push(`drafts/${organizationId}/`, `attachments/${organizationId}/`, `raw/${organizationId}/`);
  }
  return prefixes.some((prefix) => objectKey.startsWith(prefix));
}

export function normalizeStorageFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "attachment";
}

export function buildReplyHeaders(parent: { messageIdHeader?: string | null; referencesHeader?: string | null }): {
  inReplyTo: string | null;
  references: string | null;
} {
  const parentId = parent.messageIdHeader?.trim() || null;
  if (!parentId) return { inReplyTo: null, references: null };
  const existing = (parent.referencesHeader || "").split(/\s+/).map((value) => value.trim()).filter(Boolean);
  const references = [...existing.filter((value) => value !== parentId), parentId];
  const limited = references.slice(-20);
  return { inReplyTo: parentId, references: limited.join(" ") };
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workspace";
}

export function isTemporaryProviderError(status: number): boolean {
  return status === 429 || status >= 500;
}

export function mapBrevoEvent(event: string): "delivered" | "bounced" | "failed" | null {
  const map: Record<string, "delivered" | "bounced" | "failed"> = {
    delivered: "delivered",
    hard_bounce: "bounced",
    soft_bounce: "bounced",
    blocked: "failed",
    error: "failed",
    spam: "failed",
    invalid: "failed",
  };
  return map[event.toLowerCase()] || null;
}

export function takeRateLimit(input: {
  hitCount: number;
  windowStartedAt: string;
  lastHitAt?: string | null;
  now?: number;
  windowMs: number;
  maxHits: number;
  minIntervalMs?: number;
}): { allowed: boolean; hitCount: number; windowStartedAt: string } {
  const now = input.now ?? Date.now();
  const windowActive = now - Date.parse(input.windowStartedAt) < input.windowMs;
  if (!windowActive) return { allowed: true, hitCount: 1, windowStartedAt: new Date(now).toISOString() };
  if (input.minIntervalMs && input.lastHitAt && now - Date.parse(input.lastHitAt) < input.minIntervalMs) {
    return { allowed: false, hitCount: input.hitCount, windowStartedAt: input.windowStartedAt };
  }
  if (input.hitCount >= input.maxHits) return { allowed: false, hitCount: input.hitCount, windowStartedAt: input.windowStartedAt };
  return { allowed: true, hitCount: input.hitCount + 1, windowStartedAt: input.windowStartedAt };
}
