export const UNDO_SEND_SECONDS = [0, 10, 20, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_SECONDS)[number];
export const UNAVAILABLE_SCANNER_MESSAGE = "No malware scanner is configured";

export type AttachmentScanResult = { status: "clean" | "suspicious" | "blocked" | "unavailable"; reasons: string[] };
export interface AttachmentScanner {
  scan(input: { filename: string; contentType: string; sha256: string }): Promise<AttachmentScanResult>;
}

export const unavailableAttachmentScanner: AttachmentScanner = {
  async scan() {
    return { status: "unavailable", reasons: [UNAVAILABLE_SCANNER_MESSAGE] };
  },
};

export type SendWarning = {
  code: "attachment_omission" | "external_recipient" | "reply_to_mismatch" | "from_identity";
  title: string;
  detail: string;
  blocking?: boolean;
};

function normalizedEmail(value: string): string {
  return value.trim().replace(/^.*<([^>]+)>.*$/, "$1").toLowerCase();
}

function domainOf(value: string): string {
  return normalizedEmail(value).split("@").pop() || "";
}

export function normalizeUndoSeconds(value: unknown, fallback: UndoSendSeconds = 0): UndoSendSeconds {
  const numeric = Number(value);
  return UNDO_SEND_SECONDS.includes(numeric as UndoSendSeconds) ? numeric as UndoSendSeconds : fallback;
}

export function buildSendWarnings(input: {
  fromAddress: string;
  mailboxAddress?: string | null;
  mailboxCanSend?: boolean;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  text?: string;
  attachmentCount?: number;
}): SendWarning[] {
  const warnings: SendWarning[] = [];
  const from = normalizedEmail(input.fromAddress);
  const mailbox = normalizedEmail(input.mailboxAddress || "");
  const recipients = [...input.to, ...(input.cc || []), ...(input.bcc || [])].map(normalizedEmail).filter(Boolean);
  if (input.mailboxCanSend === false || !mailbox || mailbox !== from) {
    warnings.push({ code: "from_identity", title: "Check the From address", detail: "This sender is not the verified sending identity for the selected mailbox.", blocking: true });
  }
  const external = recipients.filter((recipient) => domainOf(recipient) !== domainOf(from));
  if (external.length) {
    warnings.push({ code: "external_recipient", title: "External recipient", detail: `${external.length} recipient${external.length === 1 ? " is" : "s are"} outside ${domainOf(from)}. Check the address before sending.` });
  }
  const replyTo = normalizedEmail(input.replyTo || from);
  if (replyTo && replyTo !== from) {
    warnings.push({ code: "reply_to_mismatch", title: "Reply-To is different", detail: `Replies will go to ${replyTo}, not ${from}.` });
  }
  const content = `${input.subject || ""} ${input.text || ""}`;
  if (!input.attachmentCount && /\b(attach(?:ed|ment)?|enclos(?:ed|ure)|see (?:the )?file)\b/i.test(content)) {
    warnings.push({ code: "attachment_omission", title: "No attachment added", detail: "This message mentions an attachment, but no file is attached." });
  }
  return warnings;
}

export function normalizedSendFingerprint(input: {
  fromAddress: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  text?: string;
  threadId?: string | null;
  attachments?: Array<{ filename: string; object_key: string }>;
}): string {
  const normalizeList = (items?: string[]) => (items || []).map(normalizedEmail).filter(Boolean).sort().join(",");
  const attachmentList = (input.attachments || []).map((item) => `${item.filename}:${item.object_key}`).sort().join(",");
  return [normalizedEmail(input.fromAddress), normalizeList(input.to), normalizeList(input.cc), normalizeList(input.bcc), normalizedEmail(input.replyTo || input.fromAddress), input.subject?.trim() || "(no subject)", input.text || "", input.threadId || "", attachmentList].join("\u001f");
}

export function canClaimOutbox(message: {
  status?: string | null;
  send_after?: string | null;
  send_lease_until?: string | null;
  cancelled_at?: string | null;
}, now = Date.now()): boolean {
  if (!message.status || !["queued", "scheduled"].includes(message.status)) return false;
  if (message.cancelled_at) return false;
  if (message.send_after && Date.parse(message.send_after) > now) return false;
  if (message.send_lease_until && Date.parse(message.send_lease_until) > now) return false;
  return true;
}

export function canManageOutbox(message: {
  owner_id?: string | null;
  status?: string | null;
  send_lease_until?: string | null;
  cancelled_at?: string | null;
}, ownerId: string, now = Date.now()): boolean {
  if (message.owner_id !== ownerId || !["queued", "scheduled"].includes(String(message.status))) return false;
  if (message.cancelled_at) return false;
  return !message.send_lease_until || Date.parse(message.send_lease_until) <= now;
}

function extensionMime(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop() || "";
  return ({
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

function startsWithBytes(bytes: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => bytes[index] === value);
}

export function detectAttachmentContentType(filename: string, declaredType: string, bytes: Uint8Array): string {
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return declaredType || extensionMime(filename);
}

export function buildAttachmentSafety(filename: string, declaredType: string, detectedType: string, byteSize: number): {
  safetyStatus: "unknown" | "suspicious" | "blocked";
  safetyReasons: string[];
  previewState: "ready" | "not_available";
} {
  const dangerous = /\.(exe|dll|scr|js|vbs|cmd|bat|ps1|msi|jar|hta|iso|lnk)$/i.test(filename) || /application\/(?:x-msdownload|x-sh|javascript)/i.test(declaredType) || /application\/(?:x-msdownload|x-sh|javascript)/i.test(detectedType);
  const suspicious = /\.(docm|dotm|xlsm|xltm|pptm|ppsm|zip|rar|7z)$/i.test(filename) || /application\/(?:vnd\.ms-.*macroEnabled|x-7z-compressed|x-rar-compressed)/i.test(declaredType) || /application\/(?:vnd\.ms-.*macroEnabled|x-7z-compressed|x-rar-compressed)/i.test(detectedType);
  const previewable = (detectedType === "application/pdf" || detectedType.startsWith("image/")) && byteSize <= 5 * 1024 * 1024;
  if (dangerous) return { safetyStatus: "blocked", safetyReasons: ["Executable or script content is not accepted"], previewState: "not_available" };
  if (suspicious) return { safetyStatus: "suspicious", safetyReasons: ["Archive or macro-enabled content needs extra care", UNAVAILABLE_SCANNER_MESSAGE], previewState: "not_available" };
  return { safetyStatus: "unknown", safetyReasons: ["Static type and size checks only", UNAVAILABLE_SCANNER_MESSAGE], previewState: previewable ? "ready" : "not_available" };
}

export type ZipEntry = { filename: string; data: Uint8Array };

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view: DataView, offset: number, value: number) { view.setUint16(offset, value, true); }
function writeU32(view: DataView, offset: number, value: number) { view.setUint32(offset, value >>> 0, true); }

export function buildZip(entries: ZipEntry[], maxEntries = 10, maxBytes = 25 * 1024 * 1024): Uint8Array {
  const selected = entries.slice(0, maxEntries);
  if (!selected.length) throw new Error("There are no attachments to download");
  const encoder = new TextEncoder();
  const names = new Set<string>();
  const normalized = selected.map((entry, index) => {
    const base = entry.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || `attachment-${index + 1}`;
    let name = base;
    let suffix = 2;
    while (names.has(name)) name = `${base}-${suffix++}`;
    names.add(name);
    return { nameBytes: encoder.encode(name), data: entry.data, crc: crc32(entry.data) };
  });
  const totalBytes = normalized.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  if (totalBytes > maxBytes) throw new Error(`The download is limited to ${Math.round(maxBytes / 1024 / 1024)} MB`);
  let localSize = 0;
  let centralSize = 0;
  for (const entry of normalized) { localSize += 30 + entry.nameBytes.length + entry.data.length; centralSize += 46 + entry.nameBytes.length; }
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const central: Array<{ nameBytes: Uint8Array; data: Uint8Array; crc: number; offset: number }> = [];
  for (const entry of normalized) {
    const localOffset = offset;
    writeU32(view, offset, 0x04034b50); writeU16(view, offset + 4, 20); writeU16(view, offset + 6, 0x800); writeU16(view, offset + 8, 0); writeU16(view, offset + 10, 0); writeU16(view, offset + 12, 0); writeU32(view, offset + 14, entry.crc); writeU32(view, offset + 18, entry.data.length); writeU32(view, offset + 22, entry.data.length); writeU16(view, offset + 26, entry.nameBytes.length); writeU16(view, offset + 28, 0);
    offset += 30; output.set(entry.nameBytes, offset); offset += entry.nameBytes.length; output.set(entry.data, offset); offset += entry.data.length;
    central.push({ ...entry, offset: localOffset });
  }
  const centralOffset = offset;
  for (const entry of central) {
    writeU32(view, offset, 0x02014b50); writeU16(view, offset + 4, 20); writeU16(view, offset + 6, 20); writeU16(view, offset + 8, 0x800); writeU16(view, offset + 10, 0); writeU16(view, offset + 12, 0); writeU16(view, offset + 14, 0); writeU32(view, offset + 16, entry.crc); writeU32(view, offset + 20, entry.data.length); writeU32(view, offset + 24, entry.data.length); writeU16(view, offset + 28, entry.nameBytes.length); writeU16(view, offset + 30, 0); writeU16(view, offset + 32, 0); writeU16(view, offset + 34, 0); writeU16(view, offset + 36, 0); writeU32(view, offset + 38, 0); writeU32(view, offset + 42, entry.offset);
    offset += 46; output.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
  }
  writeU32(view, offset, 0x06054b50); writeU16(view, offset + 4, 0); writeU16(view, offset + 6, 0); writeU16(view, offset + 8, normalized.length); writeU16(view, offset + 10, normalized.length); writeU32(view, offset + 12, centralSize); writeU32(view, offset + 16, centralOffset); writeU16(view, offset + 20, 0);
  return output;
}
