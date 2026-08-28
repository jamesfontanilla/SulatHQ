import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";
import PostalMime from "postal-mime";
import {
  buildWorkStatePatch,
  evaluateRule,
  normalizeRuleRecord,
  normalizeWorkState,
  ruleConflicts,
  ruleContextFromMessage,
  validateRuleInput,
  workQueueSummary,
  type RuleContext as PureRuleContext,
  type RuleDefinition,
} from "./rules.ts";
import {
  buildAttachmentSafety,
  buildSendWarnings,
  buildZip,
  canClaimOutbox,
  canManageOutbox,
  detectAttachmentContentType,
  normalizeUndoSeconds,
  normalizedSendFingerprint,
  type SendWarning,
} from "./phase3.ts";
import {
  isRecent,
  isValidRecoveryEmail,
  maskRecoveryEmail,
  normalizeRecoveryEmail,
} from "./security.ts";
import {
  extractTrustEvidence,
  authenticationAlignmentMismatches,
  normalizeAuthenticationResults,
  screeningDecisionPatch,
  selectSenderPolicy,
  type TrustAuthResults,
  type TrustPolicy,
} from "./trust.ts";
import { PlatformError, platformErrorBody } from "./platform/errors.ts";
import { inboundIdempotencyKey, objectKeyAllowed, buildReplyHeaders, takeRateLimit, mailboxAcceptsInbound } from "./platform/jobs.ts";
import { brevoTransport } from "./platform/transport.ts";
import { cleanupAbandonedMfa, ensureOrganization, handlePlatformApi, mailboxCanSend, pollDomainJobs, validateRecipients } from "./platform/handlers.ts";

interface Env {
  ASSETS: Fetcher;
  APP_DOMAIN: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  BREVO_API_KEY: string;
  B2_ENDPOINT: string;
  B2_REGION: string;
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET: string;
  OWNER_USER_ID?: string;
  BREVO_WEBHOOK_SECRET?: string;
  INTERNAL_TEST_TOKEN?: string;
  OUTLOOK_FORWARD_TO?: string;
  DEFAULT_FROM_EMAIL?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

type JsonRecord = Record<string, unknown>;
type User = { id: string; email?: string; accessToken?: string; mfaRequired?: boolean };
type Mailbox = { id: string; owner_id: string; organization_id?: string | null; domain_id?: string | null; local_part?: string | null; status?: string; address: string; display_name: string; is_default: boolean; can_send: boolean; can_receive: boolean; settings?: JsonRecord };
type Rule = RuleDefinition & { id: string; owner_id: string; conditions: JsonRecord; actions: JsonRecord; enabled: boolean; priority: number };
type StoredAttachment = { object_key: string; filename: string; content_type: string; detected_content_type: string; byte_size: number; sha256: string; preview_state: "ready" | "not_available"; safety_status: "unknown" | "suspicious" | "blocked"; safety_reasons: string[]; content_id?: string; disposition?: string | null };

const SYSTEM_FOLDERS = ["inbox", "sent", "drafts", "archive", "trash", "spam"] as const;
const SPAM_THRESHOLD = 0.70;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const error = (message: string, status = 400, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);
const platformFail = (caught: PlatformError) => json(platformErrorBody(caught), caught.status);

function cleanAddress(value: string): string {
  return value.trim().replace(/^.*<([^>]+)>.*$/, "$1").toLowerCase();
}

function splitAddresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(cleanAddress).filter(Boolean);
  return String(value ?? "").split(/[\n,;]+/).map(cleanAddress).filter(Boolean);
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, "").trim().toLowerCase() || "(no subject)";
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function headerValue(parsed: { headers?: Array<{ key: string; value: string }> }, key: string): string | undefined {
  return parsed.headers?.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value;
}

function senderIdentity(parsed: { from?: { name?: string; address?: string; group?: unknown[] }; headers?: Array<{ key: string; value: string }> }, fallback: string): { address: string; name: string } {
  const parsedFrom = parsed.from && "address" in parsed.from ? parsed.from : undefined;
  const address = cleanAddress(String(parsedFrom?.address || headerValue(parsed, "from") || fallback));
  const name = String(parsedFrom?.name || "").trim().replace(/\s+/g, " ").slice(0, 200);
  return { address, name: name && name.toLowerCase() !== address ? name : "" };
}

function supabaseHeaders(env: Env, token?: string): HeadersInit {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token ?? env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };
}

async function dbRequest<T = unknown>(env: Env, path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...supabaseHeaders(env, token), ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  if (!body.trim()) return undefined as T;
  return JSON.parse(body) as T;
}

function jwtPayload(token: string): JsonRecord {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(normalized)) as JsonRecord;
  } catch {
    return {};
  }
}

async function verifiedFactorCount(env: Env, userId: string, token: string): Promise<number> {
  void token;
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const result = await client.auth.admin.mfa.listFactors({ userId });
  if (result.error) throw result.error;
  return (result.data?.factors || []).filter((factor) => factor.status === "verified").length;
}

async function probeSupabase(env: Env): Promise<{ ok: boolean; status: number; detail?: string }> {
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, { headers: supabaseHeaders(env) });
    return { ok: response.ok, status: response.status, ...(response.ok ? {} : { detail: (await response.text()).slice(0, 180) }) };
  } catch (probeError) {
    return { ok: false, status: 0, detail: probeError instanceof Error ? probeError.message.slice(0, 180) : "Probe failed" };
  }
}

async function getUser(request: Request, env: Env): Promise<User | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization } });
  if (!response.ok) return null;
  const token = authorization.slice(7).trim();
  const user = (await response.json()) as User;
  const aal = jwtPayload(token).aal;
  const mfaRequired = aal !== "aal2" && (await verifiedFactorCount(env, user.id, token)) > 0;
  return { ...user, accessToken: token, mfaRequired };
}

function storageClient(env: Env): S3Client {
  return new S3Client({ region: env.B2_REGION, endpoint: env.B2_ENDPOINT, forcePathStyle: false, credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY } });
}

async function putObject(env: Env, key: string, body: Uint8Array | string, contentType: string): Promise<void> {
  await storageClient(env).send(new PutObjectCommand({ Bucket: env.B2_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readObject(env: Env, key: string): Promise<Uint8Array> {
  const result = await storageClient(env).send(new GetObjectCommand({ Bucket: env.B2_BUCKET, Key: key }));
  const body = result.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body) throw new Error("Attachment content is unavailable");
  if (typeof body.transformToByteArray === "function") return new Uint8Array(await body.transformToByteArray());
  return new Uint8Array(await new Response(body as unknown as BodyInit).arrayBuffer());
}

async function deleteObject(env: Env, key: string): Promise<void> {
  await storageClient(env).send(new DeleteObjectCommand({ Bucket: env.B2_BUCKET, Key: key }));
}

async function signedObjectUrl(env: Env, key: string): Promise<string> {
  return getSignedUrl(storageClient(env), new GetObjectCommand({ Bucket: env.B2_BUCKET, Key: key }), { expiresIn: 600 });
}

function trashRestoreTarget(message: JsonRecord): { folder: string; custom_folder_id: string | null } {
  const previous = typeof message.previous_folder === "string" ? message.previous_folder : "";
  if (previous.startsWith("custom:")) {
    const customFolderId = previous.slice("custom:".length);
    if (customFolderId) return { folder: "custom", custom_folder_id: customFolderId };
  }
  if (SYSTEM_FOLDERS.includes(previous as typeof SYSTEM_FOLDERS[number]) && previous !== "trash") {
    return { folder: previous, custom_folder_id: null };
  }
  return { folder: "inbox", custom_folder_id: null };
}

async function permanentlyDeleteMessage(env: Env, ownerId: string, messageId: string): Promise<void> {
  const rows = await dbRequest<Array<{ id: string; raw_object_key?: string | null }>>(
    env,
    `messages?id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(ownerId)}&folder=eq.trash&select=id,raw_object_key&limit=1`,
  );
  if (!rows[0]) throw new Error("Only messages in Trash can be deleted permanently");
  const attachments = await dbRequest<Array<{ object_key?: string | null }>>(
    env,
    `attachments?message_id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=object_key`,
  );
  const objectKeys = [rows[0].raw_object_key, ...attachments.map((attachment) => attachment.object_key)]
    .filter((key): key is string => typeof key === "string" && Boolean(key));
  await dbRequest(
    env,
    `messages?id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(ownerId)}&folder=eq.trash`,
    { method: "DELETE" },
  );
  await Promise.allSettled(objectKeys.map((key) => deleteObject(env, key)));
}

async function ensureProfileAndMailbox(env: Env, user: User): Promise<Mailbox> {
  await dbRequest(env, "profiles", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: user.id, display_name: user.email?.split("@")[0] ?? "Mailbox owner" }) });
  await dbRequest(env, "user_settings", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ owner_id: user.id }) });
  await ensureOrganization({
    env,
    user,
    db: (path, init) => dbRequest(env, path, init),
    fetch,
  }).catch(() => undefined);
  const existing = await dbRequest<Mailbox[]>(env, `mailboxes?owner_id=eq.${encodeURIComponent(user.id)}&order=is_default.desc,created_at.asc&limit=1`);
  if (existing[0]) return existing[0];
  if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
    return { id: "", owner_id: user.id, address: "", display_name: "", is_default: false, can_send: false, can_receive: false };
  }
  const created = await dbRequest<Mailbox[]>(env, "mailboxes", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, address: `james@${env.APP_DOMAIN}`, display_name: "James", is_default: true, local_part: "james", status: "active" }) });
  return created[0];
}

async function getMailbox(env: Env, ownerId: string, address: string): Promise<Mailbox | null> {
  const rows = await dbRequest<Mailbox[]>(env, `mailboxes?owner_id=eq.${encodeURIComponent(ownerId)}&address=eq.${encodeURIComponent(cleanAddress(address))}&limit=1`);
  return rows[0] ?? null;
}

async function getReceivingMailbox(env: Env, address: string): Promise<Mailbox | null> {
  const destination = cleanAddress(address);
  const rows = await dbRequest<Mailbox[]>(env, `mailboxes?address=eq.${encodeURIComponent(destination)}&limit=1`);
  const mailbox = rows[0];
  if (mailbox) return mailboxAcceptsInbound(mailbox) ? mailbox : null;
  if (!env.OWNER_USER_ID) return null;
  const ownerMailbox = await getMailbox(env, env.OWNER_USER_ID, destination);
  return mailboxAcceptsInbound(ownerMailbox) ? ownerMailbox : null;
}

async function findOrCreateThread(env: Env, ownerId: string, subject: string, inReplyTo?: string, references?: string, mailboxId?: string, organizationId?: string | null): Promise<string> {
  const referencesList = [inReplyTo, ...(references || "").split(/\s+/)].filter((value): value is string => Boolean(value)).reverse();
  for (const reference of referencesList) {
    const rows = await dbRequest<Array<{ thread_id: string }>>(env, `messages?owner_id=eq.${encodeURIComponent(ownerId)}&message_id_header=eq.${encodeURIComponent(reference)}&select=thread_id&limit=1`);
    if (rows[0]?.thread_id) return rows[0].thread_id;
  }
  const normalized = normalizeSubject(subject);
  const existing = await dbRequest<Array<{ id: string }>>(env, `threads?owner_id=eq.${encodeURIComponent(ownerId)}&subject_normalized=eq.${encodeURIComponent(normalized)}&order=last_message_at.desc&limit=1`);
  if (existing[0]) return existing[0].id;
  const created = await dbRequest<Array<{ id: string }>>(env, "threads", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: ownerId, organization_id: organizationId || null, mailbox_id: mailboxId || null, subject: subject || "(no subject)", subject_normalized: normalized, subject_preview: subject || "(no subject)" }) });
  return created[0].id;
}

function isDangerousAttachment(filename: string, mimeType: string): boolean {
  return /\.(exe|dll|scr|js|vbs|cmd|bat|ps1|msi|jar|hta|iso|lnk)$/i.test(filename) || /application\/x-msdownload|application\/x-sh|application\/javascript/i.test(mimeType);
}

function isSuspiciousAttachment(filename: string, mimeType: string): boolean {
  return /\.(docm|dotm|xlsm|xltm|pptm|ppsm|zip|rar|7z)$/i.test(filename) || /application\/vnd\.ms-.*macroEnabled|application\/x-7z-compressed|application\/x-rar-compressed/i.test(mimeType);
}

function addressDomain(address: string): string {
  const normalized = cleanAddress(address);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
  return normalized.split("@").pop() || "";
}

function authStatus(header: string, mechanism: "spf" | "dkim" | "dmarc"): string | null {
  const match = header.match(new RegExp(`\\b${mechanism}=(pass|fail|softfail|neutral|none|temperror|permerror)\\b`, "i"));
  return match?.[1]?.toLowerCase() || null;
}

function authDomain(header: string, mechanism: "spf" | "dkim" | "dmarc", parameter: string): string | null {
  const result = header.match(new RegExp(`\\b${mechanism}=[^;]+`, "i"))?.[0] || "";
  const match = result.match(new RegExp(`\\b${parameter}=([^\\s;]+)`, "i"));
  return match?.[1]?.replace(/[<>]/g, "").toLowerCase() || null;
}

function domainsAlign(left: string | null, right: string): boolean {
  return Boolean(left && right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)));
}

function urlHost(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");
}

function hasDeceptiveLink(html: string): boolean {
  const anchorPattern = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const displayed = stripHtml(match[2]).trim();
    if (!displayed || !/^[a-z][a-z0-9+.-]*:\/\//i.test(displayed)) continue;
    const displayedDomain = displayed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
    if (!domainsAlign(displayedDomain.toLowerCase().replace(/[.,;:!?]+$/, ""), urlHost(match[1]))) return true;
  }
  return false;
}

type SenderPolicy = TrustPolicy;

const SENDER_POLICY_ACTIONS = new Set(["inbox", "spam", "screen", "archive", "folder"]);

function normalizeSenderPolicyValue(matchType: "address" | "domain", value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (matchType === "address") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a complete email address");
  } else if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(normalized)) {
    throw new Error("Enter a domain such as example.com");
  }
  return normalized;
}

async function ensurePolicyMailbox(env: Env, ownerId: string, mailboxId: unknown): Promise<string | null> {
  const value = typeof mailboxId === "string" && mailboxId ? mailboxId : null;
  if (!value) return null;
  const rows = await dbRequest<Array<{ id: string }>>(env, `mailboxes?id=eq.${encodeURIComponent(value)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`);
  if (!rows[0]) throw new Error("Mailbox not found");
  return value;
}

function policyMatchesMessage(policy: SenderPolicy, message: JsonRecord): boolean {
  if (policy.enabled === false) return false;
  if (policy.mailbox_id && policy.mailbox_id !== message.mailbox_id) return false;
  const address = cleanAddress(String(message.from_address || ""));
  const domain = addressDomain(address);
  return policy.match_type === "address" ? policy.match_value.toLowerCase() === address : policy.match_value.toLowerCase().replace(/^@/, "").replace(/\.$/, "") === domain;
}

async function recordScreeningFeedback(env: Env, ownerId: string, message: JsonRecord, feedback: "spam" | "not_spam"): Promise<void> {
  const id = String(message.id || "");
  const previousFolder = String(message.folder || "inbox");
  await dbRequest(env, "spam_feedback", { method: "POST", body: JSON.stringify({ owner_id: ownerId, message_id: id, feedback }) }).catch(() => undefined);
  await dbRequest(env, "screening_events", { method: "POST", body: JSON.stringify({ owner_id: ownerId, message_id: id, decision: feedback === "spam" ? "blocked" : "allowed", previous_folder: previousFolder }) }).catch(() => undefined);
  await dbRequest(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify({ folder: feedback === "spam" ? "spam" : "inbox", custom_folder_id: null, screening_status: feedback === "spam" ? "blocked" : "approved", updated_at: new Date().toISOString() }) });
}

async function applyPolicyToMessage(env: Env, ownerId: string, message: JsonRecord, policy: SenderPolicy): Promise<void> {
  const id = String(message.id || "");
  const previousFolder = String(message.folder || "inbox");
  const patch: JsonRecord = { screening_policy_id: policy.id, updated_at: new Date().toISOString() };
  let decision: "allowed" | "blocked" | "rerouted" | "screened" = "screened";
  if (policy.action === "spam") { patch.folder = "spam"; patch.custom_folder_id = null; patch.screening_status = "blocked"; decision = "blocked"; }
  else if (policy.action === "inbox") { patch.folder = "inbox"; patch.custom_folder_id = null; patch.screening_status = "approved"; decision = "allowed"; }
  else if (policy.action === "archive") { patch.folder = "archive"; patch.custom_folder_id = null; patch.screening_status = "rerouted"; decision = "rerouted"; }
  else if (policy.action === "folder") {
    if (!policy.target_folder_id) throw new Error("This folder policy has no destination");
    const folders = await dbRequest<Array<{ id: string }>>(env, `mail_folders?id=eq.${encodeURIComponent(policy.target_folder_id)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`);
    if (!folders[0]) throw new Error("This folder policy points to a missing folder");
    patch.folder = "custom"; patch.custom_folder_id = policy.target_folder_id; patch.screening_status = "rerouted"; decision = "rerouted";
  } else if (policy.action === "screen") {
    patch.screening_status = "review";
    decision = "screened";
  }
  await dbRequest(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  await dbRequest(env, "screening_events", { method: "POST", body: JSON.stringify({ owner_id: ownerId, message_id: id, policy_id: policy.id, decision, previous_folder: previousFolder }) }).catch(() => undefined);
}

async function saveAttachments(env: Env, ownerId: string, messageId: string, attachments: Array<{ filename?: string | null; mimeType?: string; content?: Uint8Array | ArrayBuffer | string; contentId?: string | null; disposition?: string | null }>): Promise<{ stored: StoredAttachment[]; blocked: string[] }> {
  const stored: StoredAttachment[] = [];
  const blocked: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.content) continue;
    const filename = (attachment.filename || `attachment-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, "_");
    const declaredContentType = attachment.mimeType || "application/octet-stream";
    const content = attachment.content instanceof Uint8Array ? attachment.content : attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : new TextEncoder().encode(attachment.content);
    const detectedContentType = detectAttachmentContentType(filename, declaredContentType, content);
    const safety = buildAttachmentSafety(filename, declaredContentType, detectedContentType, content.byteLength);
    if (content.byteLength > 15 * 1024 * 1024 || safety.safetyStatus === "blocked") { blocked.push(filename); continue; }
    const objectKey = `attachments/${ownerId}/${messageId}/${crypto.randomUUID()}-${filename}`;
    await putObject(env, objectKey, content, detectedContentType);
    stored.push({ object_key: objectKey, filename, content_type: declaredContentType, detected_content_type: detectedContentType, byte_size: content.byteLength, sha256: await sha256Hex(content), preview_state: safety.previewState, safety_status: safety.safetyStatus, safety_reasons: safety.safetyReasons, content_id: attachment.contentId || undefined, disposition: attachment.disposition });
  }
  return { stored, blocked };
}

async function assessInbound(env: Env, ownerId: string, mailboxId: string, envelopeFrom: string, headerFrom: string, subject: string, textBody: string, htmlBody: string, parsed: { headers?: Array<{ key: string; value: string }>; attachments?: Array<{ filename?: string | null; mimeType?: string }> }): Promise<{ score: number; reasons: string[]; focusedScore: number; focusedCategory: string; authResults: TrustAuthResults; trustScore: number; trustReasons: string[]; trustEvidence: JsonRecord; receivedAuthAt: string | null; senderFirstSeen: boolean; knownContact: boolean; replyToMismatch: boolean; linkCount: number; trackingPixelCount: number; policyId: string | null; policyAction: string | null; policyTargetFolderId: string | null }> {
  let score = 0;
  let focusedScore = 0.5;
  const reasons: string[] = [];
  const authResults = normalizeAuthenticationResults(parsed.headers || []);
  const authHeader = authResults.header;
  const spf = authResults.spf;
  const dkim = authResults.dkim;
  const dmarc = authResults.dmarc;
  const authFailures = [spf, dkim, dmarc].filter((status) => status === "fail" || status === "softfail" || status === "permerror" || status === "temperror");
  if (dmarc === "fail") { score += 0.18; reasons.push("DMARC failure"); }
  if (authFailures.length) { score += 0.18 + Math.min(0.12, (authFailures.length - 1) * 0.06); reasons.push("authentication failure"); }
  if ([spf, dkim, dmarc].filter(Boolean).length >= 2 && authFailures.length === 0 && [spf, dkim, dmarc].every((status) => !status || status === "pass")) { score -= 0.08; reasons.push("authentication passed"); }
  if (envelopeFrom && headerFrom && cleanAddress(envelopeFrom) !== cleanAddress(headerFrom)) { score += 0.12; reasons.push("envelope/header sender mismatch"); }
  const visibleDomain = addressDomain(headerFrom);
  authenticationAlignmentMismatches(authResults, visibleDomain).forEach((mechanism) => {
    score += mechanism === "DMARC" ? 0.12 : 0.08;
    reasons.push(`${mechanism} alignment mismatch`);
  });
  const sender = cleanAddress(headerFrom || envelopeFrom);
  const replyTo = cleanAddress(headerValue(parsed, "reply-to") || headerFrom);
  const linkEvidence = extractTrustEvidence({ sender, replyTo, subject, textBody, htmlBody, authentication: authResults });
  if (linkEvidence.reply_to_mismatch) { score += 0.10; reasons.push("reply-to mismatch"); }
  const content = `${subject} ${textBody} ${stripHtml(htmlBody)}`;
  const urls = content.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  if (urls.length >= 5) { score += 0.10; reasons.push("many links"); }
  if (urls.some((url) => /(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly)\//i.test(url))) { score += 0.08; reasons.push("shortened link"); }
  if (urls.some((url) => /^(?:https?:\/\/)?(?:[^/]+@)?(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/i.test(url) || urlHost(url).startsWith("xn--"))) { score += 0.08; reasons.push("suspicious link host"); }
  if (hasDeceptiveLink(htmlBody)) { score += 0.16; reasons.push("deceptive link text"); }
  if (linkEvidence.tracking_pixel_count) { score += Math.min(0.10, 0.04 + linkEvidence.tracking_pixel_count * 0.02); reasons.push("tracking pixel"); }
  const credentialRequest = /(?:verify|confirm|unlock|suspend|password|login|sign[ -]?in|security code|one[- ]?time code|account)/i.test(content);
  const urgency = /(?:urgent|immediately|action required|within \d+ hours?|expires?|final notice)/i.test(content);
  const paymentRequest = /(?:wire transfer|gift card|invoice|payment due|bank account|crypto(?:currency)?|wallet)/i.test(content);
  if ((credentialRequest && urgency) || (paymentRequest && urgency) || /(?:claim your prize|password expires|wire transfer|gift card)/i.test(content)) { score += 0.18; reasons.push("high-risk request"); }
  const blocked = (parsed.attachments || []).filter((item) => isDangerousAttachment(String(item.filename || ""), String(item.mimeType || "")));
  const suspicious = (parsed.attachments || []).filter((item) => isSuspiciousAttachment(String(item.filename || ""), String(item.mimeType || "")));
  if (blocked.length) { score = Math.max(score, 0.90); reasons.push("dangerous attachment"); }
  if (suspicious.length && !blocked.length) { score += 0.16; reasons.push("suspicious attachment type"); }
  if (!textBody.trim() && htmlBody) { score += 0.04; reasons.push("HTML-only message"); }
  const knownContact = await dbRequest<Array<{ id: string }>>(env, `contacts?owner_id=eq.${encodeURIComponent(ownerId)}&email=eq.${encodeURIComponent(sender)}&limit=1`).catch(() => []);
  const previous = await dbRequest<Array<{ id: string }>>(env, `messages?owner_id=eq.${encodeURIComponent(ownerId)}&from_address=eq.${encodeURIComponent(sender)}&select=id&order=created_at.desc&limit=25`).catch(() => []);
  if (knownContact[0]) { score -= 0.25; focusedScore += 0.35; reasons.push("known contact"); }
  if (previous[0]) { score -= 0.10; focusedScore += 0.10; } else { score += 0.03; reasons.push("new sender"); }
  if (previous.length) {
    const ids = previous.map((row) => row.id).join(",");
    const feedback = await dbRequest<Array<{ feedback: "spam" | "not_spam" }>>(env, `spam_feedback?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=${encodeURIComponent(`in.(${ids})`)}&select=feedback`).catch(() => []);
    const spamReports = feedback.filter((row) => row.feedback === "spam").length;
    const notSpamReports = feedback.filter((row) => row.feedback === "not_spam").length;
    if (spamReports) { score += Math.min(0.24, spamReports * 0.08); reasons.push("sender reported as spam"); }
    if (notSpamReports) { score -= Math.min(0.36, notSpamReports * 0.12); reasons.push("sender restored as not spam"); }
  }
  const policies = await dbRequest<SenderPolicy[]>(env, `sender_policies?owner_id=eq.${encodeURIComponent(ownerId)}&enabled=eq.true&select=id,mailbox_id,match_type,match_value,action,target_folder_id,target_label_id`).catch(() => []);
  const senderPolicy = selectSenderPolicy(policies, mailboxId, sender);
  const explicitlyBlocked = senderPolicy?.action === "spam";
  const explicitlyAllowed = senderPolicy?.action === "inbox";
  if (explicitlyBlocked) reasons.push("blocked sender policy");
  if (explicitlyAllowed) reasons.push("safe sender policy");
  if (explicitlyAllowed && !blocked.length) score = Math.min(score - 0.35, 0.24);
  if (explicitlyBlocked || blocked.length) score = 1;
  if (/^no[-_]?reply@/i.test(sender)) focusedScore -= 0.2;
  score = Math.max(0, Math.min(1, score));
  focusedScore = Math.max(0, Math.min(1, focusedScore - score * 0.35));
  const trustScore = Math.max(0, Math.min(1, 1 - score));
  const trustEvidence = extractTrustEvidence({ sender, replyTo, subject, textBody, htmlBody, authentication: authResults, firstSeenSender: !previous[0], knownContact: Boolean(knownContact[0]), policyAction: senderPolicy?.action || null, policyId: senderPolicy?.id || null });
  return {
    score,
    reasons,
    focusedScore,
    focusedCategory: focusedScore >= 0.5 ? "focused" : "other",
    authResults,
    trustScore,
    trustReasons: reasons,
    trustEvidence,
    receivedAuthAt: authHeader ? new Date().toISOString() : null,
    senderFirstSeen: !previous[0],
    knownContact: Boolean(knownContact[0]),
    replyToMismatch: linkEvidence.reply_to_mismatch,
    linkCount: linkEvidence.link_count,
    trackingPixelCount: linkEvidence.tracking_pixel_count,
    policyId: senderPolicy?.id || null,
    policyAction: senderPolicy?.action || null,
    policyTargetFolderId: senderPolicy?.target_folder_id || null,
  };
}

type RuleContext = PureRuleContext;

function ruleMatches(rule: Rule, context: RuleContext): boolean {
  return evaluateRule(rule, context).matched;
}

async function applyRuleActions(env: Env, ownerId: string, messageId: string, actions: JsonRecord, forwardInbound?: (address: string) => Promise<void>): Promise<JsonRecord> {
  const patch: JsonRecord = {};
  if (typeof actions.folder === "string" && SYSTEM_FOLDERS.includes(actions.folder as typeof SYSTEM_FOLDERS[number])) {
    patch.folder = actions.folder;
    patch.custom_folder_id = null;
  }
  if (typeof actions.customFolderId === "string") {
    const folders = await dbRequest<Array<{ id: string }>>(env, `mail_folders?id=eq.${encodeURIComponent(actions.customFolderId)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`);
    if (folders[0]) {
      patch.folder = "custom";
      patch.custom_folder_id = actions.customFolderId;
    }
  }
  if (typeof actions.markRead === "boolean") patch.is_read = actions.markRead;
  if (typeof actions.star === "boolean") patch.is_starred = actions.star;
  if (typeof actions.pin === "boolean") patch.is_pinned = actions.pin;
  if (typeof actions.flag === "boolean") patch.is_flagged = actions.flag;
  if (typeof actions.priority === "number") patch.priority = Math.max(0, Math.min(2, actions.priority));
  if (Object.keys(patch).length) await dbRequest(env, `messages?id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  if (typeof actions.label === "string" && actions.label.trim()) {
    const name = actions.label.trim();
    const labels = await dbRequest<Array<{ id: string }>>(env, `labels?owner_id=eq.${encodeURIComponent(ownerId)}&name=eq.${encodeURIComponent(name)}&limit=1`);
    const label = labels[0] || (await dbRequest<Array<{ id: string }>>(env, "labels", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: ownerId, name }) }))[0];
    if (label) await dbRequest(env, "message_labels", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ message_id: messageId, label_id: label.id }) });
  }
  if (typeof actions.forwardTo === "string" && forwardInbound) await forwardInbound(cleanAddress(actions.forwardTo));
  return patch;
}

async function applyInboundRules(env: Env, ownerId: string, messageId: string, context: RuleContext, forwardInbound?: (address: string) => Promise<void>): Promise<void> {
  const rules = await dbRequest<Rule[]>(env, `mail_rules?owner_id=eq.${encodeURIComponent(ownerId)}&enabled=eq.true&order=priority.asc`);
  for (const rule of rules) {
    if (!ruleMatches(rule, context)) continue;
    const actions = rule.actions || {};
    await applyRuleActions(env, ownerId, messageId, actions, forwardInbound);
    if (actions.stopProcessing === true) break;
  }
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function buildRuleConditions(conditions: unknown, exceptions: unknown): JsonRecord {
  const next = { ...objectValue(conditions) };
  const exceptionObject = objectValue(exceptions);
  if (Object.keys(exceptionObject).length) next.exceptions = exceptionObject;
  else delete next.exceptions;
  return next;
}

type RuleMatch = { id: string; subject: string; fromAddress: string; snippet: string; folder: string; reasons: string[]; plannedActions: JsonRecord };
type RuleImpact = { folders: Record<string, number>; labels: number; markRead: number; forwardCount: number; total: number };

async function existingRuleMessages(env: Env, ownerId: string): Promise<JsonRecord[]> {
  return dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(ownerId)}&order=created_at.desc,id.desc&limit=100&select=id,thread_id,mailbox_id,folder,custom_folder_id,previous_folder,from_address,to_addresses,cc_addresses,subject,snippet,text_body,is_read,is_starred,is_pinned,is_flagged,priority,has_attachment,work_state,follow_up_at,snoozed_until`);
}

function matchRuleMessages(rows: JsonRecord[], rule: Rule): { matches: RuleMatch[]; impact: RuleImpact } {
  const matches: RuleMatch[] = [];
  const impact: RuleImpact = { folders: {}, labels: 0, markRead: 0, forwardCount: 0, total: 0 };
  for (const message of rows) {
    const result = evaluateRule(rule, ruleContextFromMessage(message));
    if (!result.matched) continue;
    const match: RuleMatch = {
      id: String(message.id),
      subject: String(message.subject || "(no subject)"),
      fromAddress: String(message.from_address || "Unknown sender"),
      snippet: String(message.snippet || message.text_body || "").slice(0, 180),
      folder: String(message.folder || "inbox"),
      reasons: result.reasons,
      plannedActions: result.plannedActions,
    };
    matches.push(match);
    impact.total += 1;
    if (typeof result.plannedActions.folder === "string") impact.folders[String(result.plannedActions.folder)] = (impact.folders[String(result.plannedActions.folder)] || 0) + 1;
    if (typeof result.plannedActions.customFolderId === "string") impact.folders.custom = (impact.folders.custom || 0) + 1;
    if (typeof result.plannedActions.label === "string" && result.plannedActions.label.trim()) impact.labels += 1;
    if (typeof result.plannedActions.markRead === "boolean") impact.markRead += 1;
    if (typeof result.plannedActions.forwardTo === "string" && result.plannedActions.forwardTo.trim()) impact.forwardCount += 1;
  }
  return { matches, impact };
}

async function createRuleRun(env: Env, ownerId: string, ruleId: string, mode: "preview" | "dry_run" | "apply" | "replay", sample: unknown[] = []): Promise<string> {
  const rows = await dbRequest<Array<{ id: string }>>(env, "mail_rule_runs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: ownerId, rule_id: ruleId, initiated_by: ownerId, mode, status: "started", sample: sample.slice(0, 20) }) });
  if (!rows[0]?.id) throw new Error("Could not create rule execution record");
  return rows[0].id;
}

async function finishRuleRun(env: Env, ownerId: string, runId: string, patch: JsonRecord): Promise<void> {
  await dbRequest(env, `mail_rule_runs?id=eq.${encodeURIComponent(runId)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify({ ...patch, completed_at: new Date().toISOString() }) });
}

function ruleImpactText(impact: RuleImpact): JsonRecord {
  return { ...impact, folders: impact.folders };
}

async function applyExistingRuleMatches(env: Env, ownerId: string, rule: Rule, runId: string, matches: RuleMatch[], rows: JsonRecord[]): Promise<{ changedCount: number; failures: Array<{ id: string; error: string }> }> {
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  const failures: Array<{ id: string; error: string }> = [];
  let changedCount = 0;
  for (const match of matches) {
    const row = rowsById.get(match.id);
    if (!row) continue;
    try {
      const before = bulkBeforeState(row);
      const beforeLabels = await dbRequest<Array<{ label_id: string }>>(env, `message_labels?message_id=eq.${encodeURIComponent(match.id)}&select=label_id`).catch(() => []);
      const patch = await applyRuleActions(env, ownerId, match.id, rule.actions || {});
      const afterLabels = await dbRequest<Array<{ label_id: string }>>(env, `message_labels?message_id=eq.${encodeURIComponent(match.id)}&select=label_id`).catch(() => []);
      const beforeIds = new Set(beforeLabels.map((label) => label.label_id));
      const addedLabelIds = afterLabels.map((label) => label.label_id).filter((id) => !beforeIds.has(id));
      const after = { ...before, ...patch, added_label_ids: addedLabelIds };
      await writeMessageAudit(env, ownerId, `rule-run:${runId}`, "rule_apply", row, before, after);
      changedCount += 1;
    } catch (applyError) {
      failures.push({ id: match.id, error: applyError instanceof Error ? applyError.message : "Rule action failed" });
    }
  }
  return { changedCount, failures };
}

async function sendViaBrevo(env: Env, input: { fromAddress: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; replyTo?: string; inReplyTo?: string; references?: string; messageIdHeader?: string; idempotencyKey?: string; attachments?: Array<{ filename: string; object_key: string }> }): Promise<{ messageId?: string }> {
  const transport = brevoTransport({
    apiKey: env.BREVO_API_KEY,
    fetch,
    signAttachment: (objectKey) => signedObjectUrl(env, objectKey),
  });
  const attachments = input.attachments?.length
    ? await Promise.all(input.attachments.map(async (attachment) => ({ filename: attachment.filename, url: await signedObjectUrl(env, attachment.object_key) })))
    : undefined;
  const result = await transport.send({
    fromAddress: input.fromAddress,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
    inReplyTo: input.inReplyTo,
    references: input.references,
    messageIdHeader: input.messageIdHeader,
    idempotencyKey: input.idempotencyKey,
    attachments,
  });
  return { messageId: result.providerMessageId };
}

type RecoveryMethodRow = {
  id: string;
  owner_id: string;
  email: string;
  verified_at: string | null;
  verification_code_hash: string | null;
  verification_expires_at: string | null;
  verification_attempts: number;
  last_sent_at: string | null;
};

type RecoveryRateLimitRow = {
  email_hash: string;
  window_started_at: string;
  sent_count: number;
  last_sent_at: string | null;
};

function recoveryMethodView(row: RecoveryMethodRow): JsonRecord {
  return {
    id: row.id,
    email_masked: maskRecoveryEmail(row.email),
    verified_at: row.verified_at,
    pending: !row.verified_at,
    last_sent_at: row.last_sent_at,
  };
}

function recoveryCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

async function defaultFromAddress(env: Env, ownerId?: string): Promise<string> {
  if (ownerId) {
    const rows = await dbRequest<Array<{ address: string }>>(
      env,
      `mailboxes?owner_id=eq.${encodeURIComponent(ownerId)}&is_default=eq.true&select=address&limit=1`,
    );
    if (rows[0]?.address) return rows[0].address;
  }
  return env.DEFAULT_FROM_EMAIL || "james@jamesfontanilla.com";
}

async function generateRecoveryLink(env: Env, email: string, redirectTo: string): Promise<string> {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const result = await client.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
  if (result.error) throw result.error;
  const data = result.data as unknown as JsonRecord;
  const properties = data.properties as JsonRecord | undefined;
  const actionLink = String(properties?.action_link || data.action_link || "");
  if (!actionLink) throw new Error("Supabase did not return a recovery link");
  return actionLink;
}

async function recoveryRateLimit(env: Env, email: string): Promise<{ allowed: boolean; row: RecoveryRateLimitRow | null }> {
  const emailHash = await sha256Hex(new TextEncoder().encode(email));
  const rows = await dbRequest<RecoveryRateLimitRow[]>(
    env,
    `account_recovery_rate_limits?email_hash=eq.${encodeURIComponent(emailHash)}&limit=1`,
  );
  const row = rows[0] || null;
  if (!row) return { allowed: true, row: null };
  const windowActive = isRecent(row.window_started_at, 60 * 60 * 1000);
  if (!windowActive) return { allowed: true, row };
  return { allowed: row.sent_count < 5 && !isRecent(row.last_sent_at, 60 * 1000), row };
}

async function recordRecoverySend(env: Env, email: string, previous: RecoveryRateLimitRow | null): Promise<void> {
  const emailHash = await sha256Hex(new TextEncoder().encode(email));
  const activeWindow = previous && isRecent(previous.window_started_at, 60 * 60 * 1000);
  await dbRequest(env, "account_recovery_rate_limits", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      email_hash: emailHash,
      window_started_at: activeWindow ? previous.window_started_at : new Date().toISOString(),
      sent_count: activeWindow ? previous.sent_count + 1 : 1,
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function handleRecoveryRequest(request: Request, env: Env): Promise<Response> {
  const generic = json({ ok: true, message: "If that address is registered, a recovery link will arrive shortly." }, 202);
  let body: JsonRecord;
  try {
    body = (await request.json()) as JsonRecord;
  } catch {
    return generic;
  }
  const email = normalizeRecoveryEmail(String(body.email || ""));
  if (!isValidRecoveryEmail(email)) return generic;
  try {
    const methods = await dbRequest<RecoveryMethodRow[]>(
      env,
      `account_recovery_methods?email=eq.${encodeURIComponent(email)}&verified_at=not.is.null&select=id,owner_id,email,verified_at,verification_code_hash,verification_expires_at,verification_attempts,last_sent_at&limit=1`,
    );
    const method = methods[0];
    if (!method) return generic;
    const rate = await recoveryRateLimit(env, email);
    if (!rate.allowed) return generic;
    const userResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(method.owner_id)}`, {
      headers: supabaseHeaders(env),
    });
    if (!userResponse.ok) return generic;
    const authUser = await userResponse.json() as { email?: string };
    const primaryEmail = normalizeRecoveryEmail(String(authUser.email || ""));
    if (!isValidRecoveryEmail(primaryEmail)) return generic;
    const redirectTo = new URL("/", request.url).toString();
    const link = await generateRecoveryLink(env, primaryEmail, redirectTo);
    const fromAddress = await defaultFromAddress(env, method.owner_id);
    await sendViaBrevo(env, {
      fromAddress,
      to: [email],
      subject: "Your Parcel password recovery link",
      text: `Use this one-time link to reset your Parcel password:\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Use this one-time link to reset your Parcel password:</p><p><a href="${link}">Reset your Parcel password</a></p><p>If you did not request this, you can ignore this email.</p>`,
    });
    await recordRecoverySend(env, email, rate.row);
  } catch {
    // Keep this response indistinguishable from an unknown address.
  }
  return generic;
}

async function ingestRawEmail(env: Env, raw: ArrayBuffer, envelopeFrom: string, envelopeTo: string, forwardInbound?: (address: string) => Promise<void>, ctx?: ExecutionContext): Promise<void> {
  const destination = cleanAddress(envelopeTo);
  const mailbox = await getReceivingMailbox(env, destination);
  if (!mailbox) {
    await dbRequest(env, "inbound_failures", { method: "POST", body: JSON.stringify({ envelope_to: destination, reason_code: "unknown_recipient", detail_redacted: "No active mailbox" }) }).catch(() => undefined);
    throw new Error(`No receiving mailbox configured for ${destination}`);
  }
  const ownerId = mailbox.owner_id;
  const parsed = await new PostalMime().parse(raw).catch(async (parseError: unknown) => {
    await dbRequest(env, "inbound_failures", { method: "POST", body: JSON.stringify({ envelope_to: destination, reason_code: "malformed_mime", detail_redacted: parseError instanceof Error ? parseError.message.slice(0, 180) : "parse failed" }) }).catch(() => undefined);
    throw parseError;
  });
  const subject = String(parsed.subject || "(no subject)");
  const textBody = String(parsed.text || "");
  const htmlBody = String(parsed.html || "");
  const messageIdHeader = headerValue(parsed, "message-id") || `<${crypto.randomUUID()}@${env.APP_DOMAIN}>`;
  const idempotencyKey = inboundIdempotencyKey(mailbox.id, messageIdHeader);
  const duplicate = await dbRequest<Array<{ id: string }>>(env, `messages?inbound_idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`);
  if (duplicate[0]) return;
  const headerDuplicate = await dbRequest<Array<{ id: string }>>(env, `messages?mailbox_id=eq.${encodeURIComponent(mailbox.id)}&message_id_header=eq.${encodeURIComponent(messageIdHeader)}&limit=1`);
  if (headerDuplicate[0]) return;
  const sender = senderIdentity(parsed, envelopeFrom);
  const headerFrom = sender.address;
  const fromName = sender.name;
  const inReplyTo = headerValue(parsed, "in-reply-to") || null;
  const references = headerValue(parsed, "references") || null;
  const messageId = crypto.randomUUID();
  const threadId = await findOrCreateThread(env, ownerId, subject, inReplyTo || undefined, references || undefined, mailbox.id, mailbox.organization_id);
  const toAddresses = splitAddresses(headerValue(parsed, "to") || destination);
  const ccAddresses = splitAddresses(headerValue(parsed, "cc") || "");
  const receivedAt = new Date().toISOString();
  try {
    const inserted = await dbRequest<Array<{ id: string }>>(env, "messages", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ id: messageId, owner_id: ownerId, organization_id: mailbox.organization_id || null, thread_id: threadId, mailbox_id: mailbox.id, direction: "inbound", folder: "inbox", status: "queued", screening_status: "none", from_name: fromName, from_address: headerFrom, to_addresses: toAddresses, cc_addresses: ccAddresses, reply_to: cleanAddress(headerValue(parsed, "reply-to") || headerFrom), subject, text_body: textBody, html_body: htmlBody || null, snippet: snippet(textBody || htmlBody.replace(/<[^>]+>/g, " ")), message_id_header: messageIdHeader, inbound_idempotency_key: idempotencyKey, in_reply_to: inReplyTo, references_header: references, raw_object_key: null, has_attachment: Boolean(parsed.attachments?.length), spam_score: 0, spam_reasons: [], focused_score: 0.5, focused_category: "focused", auth_results: {}, received_at: receivedAt }) });
    if (!inserted[0]) throw new Error("Message insert returned no row");
  } catch (insertError) {
    const message = insertError instanceof Error ? insertError.message : "";
    if (message.includes("23505") || message.toLowerCase().includes("duplicate")) return;
    throw insertError;
  }

  const finishInbound = async (): Promise<void> => {
    try {
      const assessment = await assessInbound(env, ownerId, mailbox.id, envelopeFrom, headerFrom, subject, textBody, htmlBody, parsed);
      const rawKey = `raw/${ownerId}/${messageId}.eml`;
      await putObject(env, rawKey, new Uint8Array(raw), "message/rfc822");
      const attachmentResult = await saveAttachments(env, ownerId, messageId, parsed.attachments ?? []);
      const reasons = [...assessment.reasons, ...(attachmentResult.blocked.length ? [`blocked attachments: ${attachmentResult.blocked.join(", ")}`] : [])];
      const explicitPolicy = assessment.policyAction;
      const customFolderId = explicitPolicy === "folder" ? assessment.policyTargetFolderId : null;
      const folder = explicitPolicy === "screen" ? "inbox" : explicitPolicy === "archive" && assessment.score < SPAM_THRESHOLD ? "archive" : explicitPolicy === "folder" && customFolderId && assessment.score < SPAM_THRESHOLD ? "custom" : assessment.score >= SPAM_THRESHOLD || explicitPolicy === "spam" ? "spam" : "inbox";
      const screeningStatus = explicitPolicy === "screen" || (assessment.score >= 0.35 && assessment.score < SPAM_THRESHOLD) ? "review" : folder === "spam" ? "blocked" : "none";
      await dbRequest(env, `messages?id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify({ folder, custom_folder_id: folder === "custom" ? customFolderId : null, status: "received", screening_status: screeningStatus, screening_policy_id: assessment.policyId, raw_object_key: rawKey, has_attachment: Boolean(parsed.attachments?.length), spam_score: assessment.score, spam_reasons: reasons, focused_score: assessment.focusedScore, focused_category: assessment.focusedCategory, auth_results: assessment.authResults, auth_spf: assessment.authResults.spf, auth_dkim: assessment.authResults.dkim, auth_dmarc: assessment.authResults.dmarc, auth_arc: assessment.authResults.arc, auth_tls: assessment.authResults.tls, trust_score: assessment.trustScore, trust_reasons: reasons, trust_evidence: { ...assessment.trustEvidence, blocked_attachments: attachmentResult.blocked }, received_auth_at: assessment.receivedAuthAt, sender_first_seen: assessment.senderFirstSeen, known_contact: assessment.knownContact, reply_to_mismatch: assessment.replyToMismatch, link_count: assessment.linkCount, tracking_pixel_count: assessment.trackingPixelCount, updated_at: new Date().toISOString() }) });
      await dbRequest(env, "screening_events", { method: "POST", body: JSON.stringify({ owner_id: ownerId, message_id: messageId, policy_id: assessment.policyId, decision: screeningStatus === "blocked" ? "blocked" : screeningStatus === "review" ? "screened" : "allowed", previous_folder: "inbox" }) }).catch(() => undefined);
      if (attachmentResult.stored.length) await dbRequest(env, "attachments", { method: "POST", body: JSON.stringify(attachmentResult.stored.map((attachment) => ({ ...attachment, owner_id: ownerId, organization_id: mailbox.organization_id || null, message_id: messageId, storage_provider: "b2", bucket_name: env.B2_BUCKET, original_filename: attachment.filename, scan_status: attachment.safety_status === "blocked" ? "blocked" : attachment.safety_status === "suspicious" ? "failed" : "safe" }))) });
      await dbRequest(env, `threads?id=eq.${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ last_message_at: new Date().toISOString(), subject_preview: subject, mailbox_id: mailbox.id, organization_id: mailbox.organization_id || null }) });
      await dbRequest(env, "mailbox_events", { method: "POST", body: JSON.stringify({ organization_id: mailbox.organization_id || null, mailbox_id: mailbox.id, message_id: messageId, thread_id: threadId, event_type: "message.created", folder, preview: { subject, snippet: snippet(textBody || htmlBody.replace(/<[^>]+>/g, " ")) } }) }).catch(() => undefined);
      await applyInboundRules(env, ownerId, messageId, {
        from: headerFrom,
        to: toAddresses,
        cc: ccAddresses,
        subject,
        body: textBody,
        hasAttachment: Boolean(parsed.attachments?.length),
        isRead: false,
        isFlagged: false,
        isPinned: false,
        priority: 0,
        folder,
      }, forwardInbound);
      const autoReplies = await dbRequest<Array<{ enabled: boolean; subject: string; body: string; starts_at: string | null; ends_at: string | null }>>(env, `auto_replies?owner_id=eq.${encodeURIComponent(ownerId)}&mailbox_id=eq.${encodeURIComponent(mailbox.id)}&enabled=eq.true&limit=1`);
      const autoReply = autoReplies[0];
      const now = Date.now();
      if (autoReply && (!autoReply.starts_at || now >= Date.parse(autoReply.starts_at)) && (!autoReply.ends_at || now <= Date.parse(autoReply.ends_at)) && headerFrom !== destination && !/auto-submitted|list-/i.test(headerValue(parsed, "auto-submitted") || "")) await sendViaBrevo(env, { fromAddress: destination, to: [headerFrom], subject: autoReply.subject, text: autoReply.body, replyTo: destination });
    } catch (processingError) {
      const note = processingError instanceof Error ? processingError.message.slice(0, 500) : "Inbound processing failed";
      await dbRequest(env, `messages?id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify({ status: "failed", work_note: note, updated_at: new Date().toISOString() }) }).catch(() => undefined);
      console.error("Inbound processing failed", processingError);
    }
  };
  if (ctx) ctx.waitUntil(finishInbound());
  else await finishInbound();
}

type OutboundAttachment = { filename: string; object_key: string; byte_size?: number; content_type?: string; detected_content_type?: string; sha256?: string; preview_state?: string; safety_status?: string; safety_reasons?: string[] };

async function assertMessageCanSend(env: Env, message: JsonRecord): Promise<void> {
  const fromAddress = cleanAddress(String(message.from_address || ""));
  const ownerId = String(message.owner_id || "");
  const mailboxId = typeof message.mailbox_id === "string" ? message.mailbox_id : "";
  const mailbox = mailboxId
    ? (await dbRequest<Mailbox[]>(env, `mailboxes?id=eq.${encodeURIComponent(mailboxId)}&limit=1`))[0]
    : ownerId && fromAddress ? await getMailbox(env, ownerId, fromAddress) : null;
  if (!mailbox) throw new PlatformError("MAILBOX_NOT_ACTIVE", "This address is not enabled for sending", 403);
  let domain: { sending_status?: string; verification_status?: string } | null = null;
  if (mailbox.domain_id) {
    const domains = await dbRequest<Array<{ sending_status: string; verification_status: string }>>(env, `domains?id=eq.${encodeURIComponent(mailbox.domain_id)}&limit=1`);
    domain = domains[0] || null;
  }
  const sendError = mailboxCanSend(mailbox, domain);
  if (sendError) throw sendError;
}

async function sendOutboxMessage(env: Env, message: JsonRecord): Promise<{ messageId?: string }> {
  await assertMessageCanSend(env, message);
  const attachments = await dbRequest<Array<{ filename: string; object_key: string }>>(env, `attachments?message_id=eq.${encodeURIComponent(String(message.id))}&select=filename,object_key&order=created_at.asc`);
  const result = await sendViaBrevo(env, { fromAddress: String(message.from_address), to: Array.isArray(message.to_addresses) ? message.to_addresses.map(String) : [], cc: Array.isArray(message.cc_addresses) ? message.cc_addresses.map(String) : [], bcc: Array.isArray(message.bcc_addresses) ? message.bcc_addresses.map(String) : [], subject: String(message.subject || "(no subject)"), text: String(message.text_body || ""), html: typeof message.html_body === "string" ? message.html_body : undefined, replyTo: String(message.reply_to || message.from_address), inReplyTo: typeof message.in_reply_to === "string" ? message.in_reply_to : undefined, references: typeof message.references_header === "string" ? message.references_header : undefined, messageIdHeader: typeof message.message_id_header === "string" ? message.message_id_header : undefined, idempotencyKey: typeof message.send_idempotency_key === "string" ? message.send_idempotency_key : undefined, attachments });
  await dbRequest(env, `messages?id=eq.${encodeURIComponent(String(message.id))}`, { method: "PATCH", body: JSON.stringify({ status: "sent", folder: "sent", sent_at: new Date().toISOString(), provider_message_id: result.messageId || null, scheduled_at: null, send_after: null, send_lease_until: null, work_note: "", updated_at: new Date().toISOString() }) });
  return { messageId: result.messageId };
}

async function processOutbox(env: Env, limit = 25): Promise<void> {
  const now = new Date().toISOString();
  const leaseFilter = encodeURIComponent(`(send_lease_until.is.null,send_lease_until.lt.${now})`);
  const candidates = await dbRequest<JsonRecord[]>(env, `messages?status=in.(queued,scheduled)&send_after=lte.${encodeURIComponent(now)}&cancelled_at=is.null&or=${leaseFilter}&order=send_after.asc&limit=${limit}`);
  for (const candidate of candidates) {
    const id = String(candidate.id || "");
    if (!id || !canClaimOutbox(candidate)) continue;
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    const claimed = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&status=in.(queued,scheduled)&cancelled_at=is.null&or=${leaseFilter}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ send_lease_until: leaseUntil, send_attempts: Number(candidate.send_attempts || 0) + 1, updated_at: new Date().toISOString() }) }).catch(() => []);
    if (!claimed[0]) continue;
    try {
      await sendOutboxMessage(env, claimed[0]);
    } catch (sendError) {
      const temporary = sendError instanceof PlatformError && sendError.code === "PROVIDER_TEMPORARY_FAILURE";
      await dbRequest(env, `messages?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: temporary ? "queued" : "failed", send_lease_until: null, send_after: temporary ? new Date(Date.now() + 60_000).toISOString() : null, work_note: sendError instanceof Error ? sendError.message.slice(0, 500) : "Send failed", updated_at: new Date().toISOString() }) }).catch(() => undefined);
    }
  }
}

async function handleSend(env: Env, ownerId: string | null, body: JsonRecord, ctx?: ExecutionContext): Promise<Response> {
  const fromAddress = cleanAddress(String(body.fromAddress || (ownerId ? "" : `james@${env.APP_DOMAIN}`)));
  const to = splitAddresses(body.to);
  const cc = splitAddresses(body.cc);
  const bcc = splitAddresses(body.bcc);
  try { validateRecipients(to); } catch (caught) { if (caught instanceof PlatformError) return platformFail(caught); throw caught; }
  if (!fromAddress) return error("A sender address is required", 400, "VALIDATION_FAILED");
  const mailbox = ownerId ? await getMailbox(env, ownerId, fromAddress) : null;
  if (ownerId && !mailbox) return error("From address must belong to an active mailbox you control", 403, "MAILBOX_NOT_ACTIVE");
  let domain: { sending_status?: string; verification_status?: string } | null = null;
  if (mailbox?.domain_id) {
    const domains = await dbRequest<Array<{ sending_status: string; verification_status: string }>>(env, `domains?id=eq.${encodeURIComponent(mailbox.domain_id)}&limit=1`);
    domain = domains[0] || null;
  }
  if (ownerId && mailbox) {
    const sendError = mailboxCanSend(mailbox, domain);
    if (sendError) return platformFail(sendError);
  }
  const subject = String(body.subject || "(no subject)");
  const text = String(body.text || "");
  const html = typeof body.html === "string" ? body.html : undefined;
  const replyTo = cleanAddress(String(body.replyTo || fromAddress));
  const attachments: OutboundAttachment[] = Array.isArray(body.attachments) ? body.attachments.filter((item): item is OutboundAttachment => Boolean(item && typeof item.filename === "string" && typeof item.object_key === "string")).map((item) => ({ filename: item.filename.slice(0, 180), object_key: item.object_key, byte_size: Number(item.byte_size || 0), content_type: item.content_type, detected_content_type: item.detected_content_type, sha256: item.sha256, preview_state: item.preview_state, safety_status: item.safety_status, safety_reasons: item.safety_reasons })) : [];
  if (attachments.some((attachment) => Number(attachment.byte_size || 0) > 15 * 1024 * 1024)) return error("Attachments are limited to 15 MB", 413, "ATTACHMENT_TOO_LARGE");
  const warnings = ownerId ? buildSendWarnings({ fromAddress, mailboxAddress: mailbox?.address, mailboxCanSend: mailbox?.can_send, to, cc, bcc, replyTo, subject, text, attachmentCount: attachments.length }) : [];
  const acknowledged = new Set(Array.isArray(body.warningsAcknowledged) ? body.warningsAcknowledged.map(String) : []);
  const unacknowledgedWarnings = warnings.filter((warning) => !acknowledged.has(warning.code));
  if (unacknowledgedWarnings.length) return json({ ok: false, requiresConfirmation: true, warnings: unacknowledgedWarnings }, 409);
  const parentId = typeof body.inReplyTo === "string" ? body.inReplyTo : "";
  const parent = parentId && ownerId
    ? (await dbRequest<Array<{ message_id_header?: string | null; references_header?: string | null }>>(env, `messages?owner_id=eq.${encodeURIComponent(ownerId)}&message_id_header=eq.${encodeURIComponent(parentId)}&select=message_id_header,references_header&limit=1`))[0]
    : null;
  const replyHeaders = buildReplyHeaders({
    messageIdHeader: parent?.message_id_header || (typeof body.inReplyTo === "string" ? body.inReplyTo : null),
    referencesHeader: parent?.references_header || (typeof body.references === "string" ? body.references : null),
  });
  const messageIdHeader = `<${crypto.randomUUID()}@${fromAddress.split("@")[1] || env.APP_DOMAIN}>`;
  if (!ownerId) {
    try {
      const result = await sendViaBrevo(env, { fromAddress, to, cc, bcc, subject, text, html, replyTo, inReplyTo: replyHeaders.inReplyTo || undefined, references: replyHeaders.references || undefined, messageIdHeader, attachments });
      return json({ ok: true, providerMessageId: result.messageId });
    } catch (caught) {
      if (caught instanceof PlatformError) return platformFail(caught);
      throw caught;
    }
  }
  const rateRows = await dbRequest<Array<{ hit_count: number; window_started_at: string; last_hit_at: string | null }>>(env, `platform_rate_limits?rate_key=eq.${encodeURIComponent(`send:${ownerId}`)}&limit=1`).catch(() => []);
  const rate = takeRateLimit({ hitCount: rateRows[0]?.hit_count ?? 0, windowStartedAt: rateRows[0]?.window_started_at || new Date().toISOString(), lastHitAt: rateRows[0]?.last_hit_at, windowMs: 60 * 60 * 1000, maxHits: 120, minIntervalMs: 250 });
  await dbRequest(env, "platform_rate_limits", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ rate_key: `send:${ownerId}`, window_started_at: rate.windowStartedAt, hit_count: rate.hitCount, last_hit_at: new Date().toISOString(), updated_at: new Date().toISOString() }) }).catch(() => undefined);
  if (!rate.allowed) return error("Sending is rate limited", 429, "SEND_RATE_LIMITED");
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim().slice(0, 200) : crypto.randomUUID();
  const duplicate = await dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(ownerId)}&send_idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,status,folder,send_after,scheduled_at&limit=1`);
  if (duplicate[0]) return json({ ok: true, replayed: true, id: duplicate[0].id, status: duplicate[0].status, scheduled: duplicate[0].status === "scheduled" });
  for (const attachment of attachments) if (!objectKeyAllowed(ownerId, mailbox?.organization_id || null, attachment.object_key)) return error("Attachment ownership could not be verified", 403);
  const threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : await findOrCreateThread(env, ownerId, subject, replyHeaders.inReplyTo || undefined, replyHeaders.references || undefined, mailbox?.id, mailbox?.organization_id);
  const scheduledInput = typeof body.scheduledAt === "string" && body.scheduledAt ? body.scheduledAt : null;
  const scheduledDate = scheduledInput ? new Date(scheduledInput) : null;
  if (scheduledInput && (!scheduledDate || Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now())) return error("Scheduled send time must be in the future");
  const configuredUndo = normalizeUndoSeconds(objectValue(mailbox?.settings).send_undo_seconds, 0);
  const undoSeconds = scheduledDate ? 0 : normalizeUndoSeconds(body.undoSendSeconds, configuredUndo);
  const sendAfter = scheduledDate ? scheduledDate.toISOString() : new Date(Date.now() + undoSeconds * 1000).toISOString();
  const inserted = await dbRequest<Array<{ id: string }>>(env, "messages", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: ownerId, organization_id: mailbox?.organization_id || null, thread_id: threadId, mailbox_id: mailbox?.id, direction: "outbound", folder: scheduledDate ? "drafts" : "sent", status: scheduledDate ? "scheduled" : "queued", from_name: mailbox?.display_name || "", from_address: fromAddress, to_addresses: to, cc_addresses: cc, bcc_addresses: bcc, reply_to: replyTo, subject, text_body: text, html_body: html || null, snippet: snippet(text), message_id_header: messageIdHeader, in_reply_to: replyHeaders.inReplyTo, references_header: replyHeaders.references, has_attachment: attachments.length > 0, scheduled_at: scheduledDate?.toISOString() || null, send_after: sendAfter, send_idempotency_key: idempotencyKey, send_warning_acknowledged: Object.fromEntries(warnings.map((warning) => [warning.code, true])), sent_at: null }) });
  const messageId = inserted[0]?.id;
  if (!messageId) return error("The message could not be queued", 502);
  if (attachments.length) {
    await dbRequest(env, "attachments", {
      method: "POST",
      body: JSON.stringify(attachments.map((attachment) => ({
        owner_id: ownerId,
        message_id: messageId,
        object_key: attachment.object_key,
        filename: attachment.filename,
        content_type: attachment.content_type || "application/octet-stream",
        detected_content_type: attachment.detected_content_type || attachment.content_type || "application/octet-stream",
        byte_size: attachment.byte_size || 0,
        sha256: attachment.sha256 || null,
        preview_state: attachment.preview_state === "ready" ? "ready" : "not_available",
        safety_status: ["unknown", "suspicious", "blocked", "infected"].includes(String(attachment.safety_status)) ? attachment.safety_status : "unknown",
        safety_reasons: Array.isArray(attachment.safety_reasons) ? attachment.safety_reasons : ["No malware scanner is configured"],
      }))),
    });
  }
  const run = async () => { if (undoSeconds) await new Promise<void>((resolve) => setTimeout(resolve, undoSeconds * 1000)); await processOutbox(env); };
  if (ctx) { if (scheduledDate) return json({ ok: true, id: messageId, scheduled: true, sendAfter }); ctx.waitUntil(run()); return json({ ok: true, id: messageId, status: "queued", sendAfter, undoSeconds }); }
  await run();
  return json({ ok: true, id: messageId, status: "queued", sendAfter, undoSeconds });
}

async function processScheduled(env: Env): Promise<void> {
  await processOutbox(env);
  const db = <T = unknown>(path: string, init?: RequestInit) => dbRequest<T>(env, path, init);
  await pollDomainJobs(env, db).catch(() => undefined);
  await cleanupAbandonedMfa(env, db).catch(() => undefined);
  const now = new Date().toISOString();
  const snoozed = await dbRequest<JsonRecord[]>(env, `messages?snoozed_until=lte.${encodeURIComponent(now)}&limit=50`);
  for (const message of snoozed) await dbRequest(env, `messages?id=eq.${encodeURIComponent(String(message.id))}`, { method: "PATCH", body: JSON.stringify({ folder: message.previous_folder || "inbox", previous_folder: null, snoozed_until: null }) }).catch(() => undefined);
  await processDueFollowUps(env, now);
}

async function processDueFollowUps(env: Env, now = new Date().toISOString()): Promise<void> {
  const due = await dbRequest<JsonRecord[]>(env, `messages?work_state=neq.none&follow_up_at=not.is.null&follow_up_at=lte.${encodeURIComponent(now)}&order=follow_up_at.asc&limit=100&select=id,owner_id,work_state,follow_up_at,subject`);
  for (const message of due) {
    const messageId = String(message.id);
    const ownerId = String(message.owner_id);
    const followUpAt = String(message.follow_up_at || "");
    const previous = await dbRequest<JsonRecord[]>(env, `mail_events?message_id=eq.${encodeURIComponent(messageId)}&event_type=eq.work_follow_up_due&order=created_at.desc&limit=1&select=payload`).catch(() => []);
    const previousAt = previous[0] && objectValue(previous[0].payload).followUpAt;
    if (previousAt && String(previousAt) === followUpAt) continue;
    await dbRequest(env, "mail_events", { method: "POST", body: JSON.stringify({ owner_id: ownerId, message_id: messageId, provider: "parcel", event_type: "work_follow_up_due", payload: { messageId, workState: message.work_state, followUpAt, subject: message.subject || "(no subject)" } }) }).catch(() => undefined);
  }
}

async function handleDraft(env: Env, user: User, body: JsonRecord): Promise<Response> {
  const fromAddress = cleanAddress(String(body.fromAddress || ""));
  const mailbox = fromAddress ? await getMailbox(env, user.id, fromAddress) : (await dbRequest<Mailbox[]>(env, `mailboxes?owner_id=eq.${encodeURIComponent(user.id)}&order=is_default.desc&limit=1`))[0];
  if (!mailbox) return error("Sender mailbox not found", 404, "MAILBOX_NOT_ACTIVE");
  const id = typeof body.id === "string" ? body.id : "";
  const patch: JsonRecord = { subject: String(body.subject || ""), text_body: String(body.text || ""), html_body: typeof body.html === "string" ? body.html : null, to_addresses: splitAddresses(body.to), cc_addresses: splitAddresses(body.cc), bcc_addresses: splitAddresses(body.bcc), from_name: mailbox.display_name || "", from_address: mailbox.address, snippet: snippet(String(body.text || "")), updated_at: new Date().toISOString() };
  if (id) {
    const current = await dbRequest<Array<{ draft_revision?: number }>>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&folder=eq.drafts&select=id,draft_revision&limit=1`);
    if (!current[0]) return error("Draft not found", 404, "NOT_FOUND");
    if (body.revision != null && Number(body.revision) !== Number(current[0].draft_revision || 1)) {
      return error("This draft was updated elsewhere. Reload and try again.", 409, "DRAFT_CONFLICT");
    }
    patch.draft_revision = Number(current[0].draft_revision || 1) + 1;
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&folder=eq.drafts`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    return json(rows?.[0] || null);
  }
  const threadId = await findOrCreateThread(env, user.id, String(patch.subject || ""), undefined, undefined, mailbox.id, mailbox.organization_id);
  const rows = await dbRequest<JsonRecord[]>(env, "messages", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, organization_id: mailbox.organization_id || null, thread_id: threadId, mailbox_id: mailbox.id, direction: "outbound", folder: "drafts", status: "draft", draft_revision: 1, message_id_header: `<${crypto.randomUUID()}@${env.APP_DOMAIN}>`, ...patch }) });
  return json(rows?.[0] || null, 201);
}

type SearchToken = { value: string; quoted: boolean; negated: boolean };
type SearchTextPart = { value: string; negated: boolean };
type SearchField = "from" | "to" | "cc" | "subject" | "filename" | "rfc822msgid";
type SearchStateField = "is_read" | "is_starred" | "is_flagged" | "is_pinned" | "has_attachment";
type SearchFilter =
  | { kind: "field"; field: SearchField; value: string; negated: boolean }
  | { kind: "state"; field: SearchStateField; value: boolean; negated: boolean }
  | { kind: "folder"; value: string; negated: boolean }
  | { kind: "date"; operator: "after" | "before"; value: string; negated: boolean }
  | { kind: "size"; operator: "larger" | "smaller"; bytes: number; negated: boolean };
type ParsedSearch = { normalized: string; terms: SearchTextPart[]; phrases: SearchTextPart[]; filters: SearchFilter[] };

function tokenizeSearch(value: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (index >= value.length) break;
    let negated = false;
    if (value[index] === "-") { negated = true; index += 1; }
    let token = "";
    let quoted = false;
    while (index < value.length && !/\s/.test(value[index])) {
      if (value[index] === '"') {
        quoted = true;
        index += 1;
        const start = index;
        while (index < value.length && value[index] !== '"') index += 1;
        if (index >= value.length) throw new Error("Unclosed quoted phrase");
        token += value.slice(start, index);
        index += 1;
      } else {
        token += value[index];
        index += 1;
      }
    }
    if (!token.trim()) throw new Error("A negation must be followed by a search term");
    tokens.push({ value: token.trim(), quoted, negated });
  }
  return tokens;
}

function parseSearchDate(value: string, operator: string): string {
  const now = new Date();
  const lower = value.toLowerCase();
  let date: Date;
  if (lower === "today") date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  else if (lower === "yesterday") date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  else {
    const relative = lower.match(/^(\d+)([dwmy])$/);
    if (relative) {
      date = new Date(now);
      const amount = Number(relative[1]);
      if (relative[2] === "d") date.setUTCDate(date.getUTCDate() - amount);
      if (relative[2] === "w") date.setUTCDate(date.getUTCDate() - amount * 7);
      if (relative[2] === "m") date.setUTCMonth(date.getUTCMonth() - amount);
      if (relative[2] === "y") date.setUTCFullYear(date.getUTCFullYear() - amount);
    } else {
      date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
    }
  }
  if (Number.isNaN(date.getTime())) throw new Error(`${operator}: invalid date "${value}"; use YYYY-MM-DD, today, or a relative value such as 7d`);
  return date.toISOString();
}

function parseSearchBytes(value: string, operator: string): number {
  const match = value.toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|kib|mb|mib|gb|gib)?$/);
  if (!match) throw new Error(`${operator}: invalid size "${value}"; use values such as 500KB or 5MB`);
  const multipliers: Record<string, number> = { b: 1, kb: 1000, kib: 1024, mb: 1000 ** 2, mib: 1024 ** 2, gb: 1000 ** 3, gib: 1024 ** 3 };
  return Math.round(Number(match[1]) * (multipliers[match[2] || "b"] || 1));
}

function parseSearchQuery(input: string): ParsedSearch {
  const query = input.trim();
  if (query.length > 1000) throw new Error("Search query is too long; keep it under 1,000 characters");
  const terms: SearchTextPart[] = [];
  const phrases: SearchTextPart[] = [];
  const filters: SearchFilter[] = [];
  const normalized: string[] = [];
  for (const token of tokenizeSearch(query)) {
    const colon = token.value.indexOf(":");
    if (colon <= 0) {
      const target = token.quoted ? phrases : terms;
      target.push({ value: token.value, negated: token.negated });
      normalized.push(`${token.negated ? "-" : ""}${token.quoted ? `"${token.value}"` : token.value}`);
      continue;
    }
    const operator = token.value.slice(0, colon).toLowerCase();
    const operand = token.value.slice(colon + 1).trim();
    if (!operand) throw new Error(`${operator}: needs a value`);
    normalized.push(`${token.negated ? "-" : ""}${operator}:${token.quoted ? `"${operand}"` : operand}`);
    if (["from", "to", "cc", "subject", "filename", "rfc822msgid"].includes(operator)) {
      filters.push({ kind: "field", field: operator as SearchField, value: operand, negated: token.negated });
      continue;
    }
    if (operator === "has") {
      if (operand.toLowerCase() !== "attachment") throw new Error(`has: unsupported value "${operand}"; use has:attachment`);
      filters.push({ kind: "state", field: "has_attachment", value: true, negated: token.negated });
      continue;
    }
    if (operator === "is") {
      const states: Record<string, { field: SearchStateField; value: boolean }> = {
        unread: { field: "is_read", value: false }, read: { field: "is_read", value: true },
        starred: { field: "is_starred", value: true }, unstarred: { field: "is_starred", value: false },
        flagged: { field: "is_flagged", value: true }, unflagged: { field: "is_flagged", value: false },
        pinned: { field: "is_pinned", value: true }, unpinned: { field: "is_pinned", value: false },
      };
      const state = states[operand.toLowerCase()];
      if (!state) throw new Error(`is: unsupported value "${operand}"; use unread, read, starred, flagged, or pinned`);
      filters.push({ kind: "state", ...state, negated: token.negated });
      continue;
    }
    if (operator === "in") {
      const folder = operand.toLowerCase();
      const validFolder = folder === "all" || SYSTEM_FOLDERS.includes(folder as typeof SYSTEM_FOLDERS[number]) || (folder.startsWith("custom:") && /^[0-9a-f-]{36}$/i.test(folder.slice(7)));
      if (!validFolder) throw new Error(`in: unknown folder "${operand}"`);
      filters.push({ kind: "folder", value: folder, negated: token.negated });
      continue;
    }
    if (["after", "before", "older", "newer"].includes(operator)) {
      const dateOperator = operator === "after" || operator === "newer" ? "after" : "before";
      filters.push({ kind: "date", operator: dateOperator, value: parseSearchDate(operand, operator), negated: token.negated });
      continue;
    }
    if (operator === "larger" || operator === "smaller") {
      filters.push({ kind: "size", operator, bytes: parseSearchBytes(operand, operator), negated: token.negated });
      continue;
    }
    throw new Error(`Unknown search operator "${operator}:"`);
  }
  return { normalized: normalized.join(" "), terms, phrases, filters };
}

function safeLike(value: string): string {
  return value.replace(/[*,()%_]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function safeFts(value: string): string {
  return value.replace(/[^\p{L}\p{N}@._-]+/gu, " ").trim().slice(0, 200);
}

function webSearchValue(parsed: ParsedSearch): string {
  return [...parsed.terms, ...parsed.phrases].map((part) => {
    const value = safeFts(part.value);
    if (!value) return "";
    const text = parsed.phrases.includes(part) ? `"${value}"` : value;
    return `${part.negated ? "-" : ""}${text}`;
  }).filter(Boolean).join(" ");
}

async function attachmentSearchIds(env: Env, ownerId: string, filters: SearchFilter[]): Promise<{ include: string[] | null; exclude: string[] }> {
  let include: Set<string> | null = null;
  const exclude = new Set<string>();
  for (const filter of filters) {
    if (filter.kind !== "field" && filter.kind !== "size") continue;
    const condition = filter.kind === "field"
      ? `filename=ilike.*${encodeURIComponent(safeLike(filter.value))}*`
      : `${filter.operator === "larger" ? (filter.negated ? "byte_size=lte." : "byte_size=gt.") : (filter.negated ? "byte_size=gte." : "byte_size=lt.")}${filter.bytes}`;
    if (filter.kind === "field" && filter.field !== "filename") continue;
    const rows = await dbRequest<Array<{ message_id: string }>>(env, `attachments?owner_id=eq.${encodeURIComponent(ownerId)}&${condition}&select=message_id&limit=10000`);
    const ids = new Set(rows.map((row) => row.message_id));
    if (filter.negated) ids.forEach((id) => exclude.add(id));
    else if (include === null) include = ids;
    else {
      const currentInclude = include as Set<string>;
      include = new Set<string>([...currentInclude].filter((id) => ids.has(id)));
    }
  }
  return { include: include ? [...include] : null, exclude: [...exclude] };
}

type MailQueryOptions = { folder: string; query?: string; filter?: string; sort?: string; page?: number; pageSize?: number };

async function buildMailQuery(env: Env, ownerId: string, options: MailQueryOptions): Promise<{ path: string; parsed?: ParsedSearch; page: number; pageSize: number; searchActive: boolean }> {
  const query = options.query?.trim() || "";
  const parsed = query ? parseSearchQuery(query) : undefined;
  const page = Math.max(1, Math.min(100, Number(options.page || 1)));
  const pageSize = Math.max(10, Math.min(100, Number(options.pageSize || 80)));
  const parts = [`owner_id=eq.${encodeURIComponent(ownerId)}`, "select=id,thread_id,mailbox_id,direction,folder,status,custom_folder_id,previous_folder,from_name,from_address,to_addresses,cc_addresses,subject,snippet,is_read,is_starred,is_pinned,is_flagged,priority,has_attachment,spam_score,spam_reasons,trust_score,trust_reasons,screening_status,focused_score,focused_category,scheduled_at,snoozed_until,work_state,follow_up_at,work_note,received_at,sent_at,created_at"];
  const explicitFolders = parsed?.filters.filter((filter): filter is Extract<SearchFilter, { kind: "folder" }> => filter.kind === "folder") || [];
  if (!parsed) {
    if (options.folder.startsWith("custom:")) { parts.push("folder=eq.custom", `custom_folder_id=eq.${encodeURIComponent(options.folder.slice(7))}`); }
    else if (options.folder === "focused") parts.push("folder=eq.inbox", "focused_category=eq.focused");
    else if (options.folder === "other") parts.push("folder=eq.inbox", "focused_category=eq.other");
    else if (options.folder !== "all") parts.push(`folder=eq.${encodeURIComponent(options.folder)}`);
  } else {
    for (const folder of explicitFolders) {
      if (folder.value === "all") continue;
      if (folder.value.startsWith("custom:")) {
        if (folder.negated) throw new Error("Negating a custom folder is not supported; use a positive in: folder filter");
        parts.push("folder=eq.custom", `custom_folder_id=eq.${encodeURIComponent(folder.value.slice(7))}`);
      } else parts.push(`folder=${folder.negated ? "not.eq" : "eq"}.${encodeURIComponent(folder.value)}`);
    }
    const fts = webSearchValue(parsed);
    if (fts) parts.push(`search_vector=wfts.${encodeURIComponent(fts)}`);
    for (const filter of parsed.filters) {
      if (filter.kind === "field") {
        if (filter.field === "filename") continue;
        if (filter.field === "rfc822msgid") { parts.push(`message_id_header=${filter.negated ? "not.eq" : "eq"}.${encodeURIComponent(filter.value)}`); continue; }
        if (filter.field === "to" || filter.field === "cc") {
          const values = `{${safeLike(filter.value).replace(/[{}]/g, "")}}`;
          parts.push(`${filter.field}_addresses=${filter.negated ? "not.cs" : "cs"}.${encodeURIComponent(values)}`);
          continue;
        }
        const column = filter.field === "from" ? "from_address" : filter.field;
        parts.push(`${column}=${filter.negated ? "not.ilike" : "ilike"}.*${encodeURIComponent(safeLike(filter.value))}*`);
      }
      if (filter.kind === "state") {
        const value = filter.negated ? !filter.value : filter.value;
        parts.push(`${filter.field}=eq.${value}`);
      }
      if (filter.kind === "date") {
        const after = filter.operator === "after";
        const operator = filter.negated ? (after ? "lt" : "gte") : (after ? "gte" : "lt");
        parts.push(`created_at=${operator}.${encodeURIComponent(filter.value)}`);
      }
    }
    const attachmentIds = await attachmentSearchIds(env, ownerId, parsed.filters);
    if (attachmentIds.include) parts.push(`id=${encodeURIComponent(`in.(${attachmentIds.include.join(",")})`)}`);
    if (attachmentIds.exclude.length) parts.push(`id=${encodeURIComponent(`not.in.(${attachmentIds.exclude.join(",")})`)}`);
  }
  const listFilter = options.filter || "all";
  if (listFilter === "unread") parts.push("is_read=eq.false");
  if (listFilter === "starred") parts.push("is_starred=eq.true");
  if (listFilter === "attachments") parts.push("has_attachment=eq.true");
  parts.push(`order=${options.sort === "oldest" ? "created_at.asc,id.asc" : "created_at.desc,id.desc"}`, `offset=${(page - 1) * pageSize}`, `limit=${pageSize + 1}`);
  return { path: `messages?${parts.join("&")}`, parsed, page, pageSize, searchActive: Boolean(parsed) };
}

async function dbRequestCount(env: Env, path: string, token?: string): Promise<number | null> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: { ...supabaseHeaders(env, token), Prefer: "count=exact" } });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const range = response.headers.get("content-range") || "";
  const total = range.match(/\/(\d+)$/)?.[1];
  return total ? Number(total) : null;
}

async function writeMessageAudit(env: Env, ownerId: string, requestId: string, actionType: string, message: JsonRecord, beforeState: JsonRecord, afterState: JsonRecord): Promise<void> {
  await dbRequest(env, "message_audit_log", { method: "POST", body: JSON.stringify({ owner_id: ownerId, actor_id: ownerId, mailbox_id: message.mailbox_id || null, message_id: message.id, thread_id: message.thread_id || null, action_type: actionType, target_type: "message", target_id: message.id, before_state: beforeState, after_state: afterState, request_id: requestId }) });
}

function bulkBeforeState(message: JsonRecord): JsonRecord {
  return {
    folder: message.folder, custom_folder_id: message.custom_folder_id || null, previous_folder: message.previous_folder || null,
    is_read: message.is_read === true, is_starred: message.is_starred === true, is_pinned: message.is_pinned === true,
    is_flagged: message.is_flagged === true, priority: typeof message.priority === "number" ? message.priority : 0,
    work_state: message.work_state || "none", follow_up_at: message.follow_up_at || null, snoozed_until: message.snoozed_until || null,
  };
}

async function applyBulkMessageAction(env: Env, ownerId: string, message: JsonRecord, action: JsonRecord, requestId: string): Promise<{ changed: boolean; exportRow?: JsonRecord }> {
  const type = String(action.type || "");
  const before = bulkBeforeState(message);
  if (type === "export") return { changed: false, exportRow: { id: message.id, subject: message.subject || "", from_address: message.from_address || "", to_addresses: message.to_addresses || [], text_body: message.text_body || message.snippet || "" } };
  if (type === "create_task") {
    await dbRequest(env, "tasks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ owner_id: ownerId, title: String(message.subject || "(no subject)"), notes: String(message.snippet || ""), source_message_id: message.id }) });
    await writeMessageAudit(env, ownerId, requestId, `bulk_${type}`, message, before, before);
    return { changed: true };
  }
  if (type === "label") {
    const labelId = String(action.labelId || "");
    const labels = await dbRequest<Array<{ id: string }>>(env, `labels?id=eq.${encodeURIComponent(labelId)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`);
    if (!labels[0]) throw new Error("Label not found");
    await dbRequest(env, "message_labels", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ message_id: message.id, label_id: labelId }) });
    await writeMessageAudit(env, ownerId, requestId, `bulk_${type}`, message, before, { label_id: labelId });
    return { changed: true };
  }
  if (type === "restore") {
    if (message.folder !== "trash") throw new Error("Only messages in Trash can be restored");
    const target = trashRestoreTarget(message);
    const rows = target.folder === "custom" ? await dbRequest<JsonRecord[]>(env, `mail_folders?id=eq.${encodeURIComponent(target.custom_folder_id || "")}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`) : [{ id: "system" }];
    const restore = rows[0] ? target : { folder: "inbox", custom_folder_id: null };
    const patch = { folder: restore.folder, custom_folder_id: restore.custom_folder_id, previous_folder: null };
    await dbRequest(env, `messages?id=eq.${encodeURIComponent(String(message.id))}&owner_id=eq.${encodeURIComponent(ownerId)}&folder=eq.trash`, { method: "PATCH", body: JSON.stringify(patch) });
    await writeMessageAudit(env, ownerId, requestId, `bulk_${type}`, message, before, patch);
    return { changed: true };
  }
  const patch: JsonRecord = {};
  if (type === "archive") { patch.folder = "archive"; patch.custom_folder_id = null; }
  else if (type === "trash") {
    patch.folder = "trash";
    patch.custom_folder_id = null;
    patch.previous_folder = message.folder === "trash"
      ? (message.previous_folder || "inbox")
      : (message.folder === "custom" && message.custom_folder_id ? `custom:${message.custom_folder_id}` : (message.folder || "inbox"));
  }
  else if (type === "spam") { patch.folder = "spam"; patch.custom_folder_id = null; }
  else if (type === "move") {
    const folder = String(action.folder || "");
    if (folder === "custom") {
      const customFolderId = String(action.customFolderId || "");
      const customFolders = await dbRequest<Array<{ id: string }>>(env, `mail_folders?id=eq.${encodeURIComponent(customFolderId)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`);
      if (!customFolders[0]) throw new Error("Choose a valid destination folder");
      patch.folder = "custom";
      patch.custom_folder_id = customFolderId;
    } else {
      if (!SYSTEM_FOLDERS.includes(folder as typeof SYSTEM_FOLDERS[number])) throw new Error("Choose a valid destination folder");
      patch.folder = folder;
      patch.custom_folder_id = null;
    }
    patch.previous_folder = null;
  } else if (type === "mark_read" || type === "mark_unread") patch.is_read = type === "mark_read";
  else if (type === "star" || type === "unstar") patch.is_starred = type === "star";
  else if (type === "pin" || type === "unpin") patch.is_pinned = type === "pin";
  else if (type === "flag" || type === "unflag") patch.is_flagged = type === "flag";
  else if (type === "priority") patch.priority = Math.max(0, Math.min(2, Number(action.priority || 0)));
  else if (type === "snooze") { patch.previous_folder = message.folder; patch.snoozed_until = String(action.snoozedUntil || new Date(Date.now() + 60 * 60 * 1000).toISOString()); patch.folder = "archive"; }
  else if (["reply_later", "waiting_on", "i_owe"].includes(type)) { patch.work_state = type; patch.follow_up_at = String(action.followUpAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()); }
  else throw new Error(`Unsupported bulk action "${type}"`);
  await dbRequest(env, `messages?id=eq.${encodeURIComponent(String(message.id))}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  await writeMessageAudit(env, ownerId, requestId, `bulk_${type}`, message, before, patch);
  return { changed: true };
}

function protectedHeaders(response: Response, noStore = false): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (noStore || headers.get("content-type")?.includes("text/html")) {
    headers.set("Cache-Control", "no-store");
    headers.set("CDN-Cache-Control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({ ok: true, service: "email-service", configured: { supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), brevo: Boolean(env.BREVO_API_KEY), b2: Boolean(env.B2_ENDPOINT && env.B2_BUCKET && env.B2_KEY_ID && env.B2_APPLICATION_KEY), inboundOwner: Boolean(env.OWNER_USER_ID) }, supabaseProbe: await probeSupabase(env), timestamp: new Date().toISOString() });
  if (url.pathname === "/api/webhooks/brevo") {
    const secret = url.searchParams.get("token") || request.headers.get("x-webhook-secret");
    if (!env.BREVO_WEBHOOK_SECRET || secret !== env.BREVO_WEBHOOK_SECRET) return error("Unauthorized", 401);
    const event = (await request.json()) as JsonRecord;
    const providerMessageId = typeof event["message-id"] === "string" ? event["message-id"] : String(event.messageId || "");
    const providerEventId = String(event["event-id"] || event.id || event.uuid || `${providerMessageId}:${event.event || ""}:${event.date || event.ts || ""}`);
    const existingEvent = providerEventId
      ? await dbRequest<Array<{ id: string }>>(env, `mail_events?provider=eq.brevo&provider_event_id=eq.${encodeURIComponent(providerEventId)}&limit=1`).catch(() => [])
      : [];
    if (existingEvent[0]) return json({ ok: true, duplicate: true });
    const rows = providerMessageId ? await dbRequest<Array<{ id: string; owner_id: string; organization_id?: string | null }>>(env, `messages?provider_message_id=eq.${encodeURIComponent(providerMessageId)}&limit=1`) : [];
    const statusMap: Record<string, string> = { delivered: "delivered", hard_bounce: "bounced", soft_bounce: "bounced", blocked: "failed", error: "failed" };
    if (rows[0]) {
      const status = statusMap[String(event.event || "").toLowerCase()];
      if (status) await dbRequest(env, `messages?id=eq.${encodeURIComponent(rows[0].id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await dbRequest(env, "mail_events", { method: "POST", body: JSON.stringify({ owner_id: rows[0].owner_id, organization_id: rows[0].organization_id || null, message_id: rows[0].id, provider: "brevo", event_type: String(event.event || "unknown"), provider_message_id: providerMessageId, provider_event_id: providerEventId, payload: { event: event.event, ts: event.date || event.ts || null } }) }).catch(() => undefined);
    }
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/recovery-request") return handleRecoveryRequest(request, env);
  if (url.pathname === "/api/internal/send-test") { if (!env.INTERNAL_TEST_TOKEN || request.headers.get("x-internal-test-token") !== env.INTERNAL_TEST_TOKEN) return error("Unauthorized", 401); try { return await handleSend(env, null, (await request.json()) as JsonRecord, ctx); } catch (sendError) { return error(sendError instanceof Error ? sendError.message : "Send failed", 502); } }
  const user = await getUser(request, env);
  if (!user) return error("Sign in required", 401);
  if (user.mfaRequired) return error("Complete two-step verification to continue", 401, "MFA_PENDING");
  const platformResponse = await handlePlatformApi(request, env, user, (path, init) => dbRequest(env, path, init));
  if (platformResponse) return platformResponse;
  const mailbox = await ensureProfileAndMailbox(env, user);

  if (request.method === "GET" && url.pathname === "/api/recovery-methods") {
    const rows = await dbRequest<RecoveryMethodRow[]>(
      env,
      `account_recovery_methods?owner_id=eq.${encodeURIComponent(user.id)}&order=created_at.asc`,
    );
    return json(rows.map(recoveryMethodView));
  }
  if (request.method === "POST" && url.pathname === "/api/recovery-methods") {
    const body = (await request.json()) as JsonRecord;
    const email = normalizeRecoveryEmail(String(body.email || ""));
    if (!isValidRecoveryEmail(email)) return error("Enter a valid recovery email address");
    if (email === normalizeRecoveryEmail(String(user.email || ""))) return error("Use an email address different from your sign-in email");
    const existingRows = await dbRequest<RecoveryMethodRow[]>(
      env,
      `account_recovery_methods?owner_id=eq.${encodeURIComponent(user.id)}&email=eq.${encodeURIComponent(email)}&limit=1`,
    );
    const existing = existingRows[0];
    if (existing?.verified_at) return error("That recovery email is already verified");
    if (existing?.last_sent_at && isRecent(existing.last_sent_at, 60 * 1000)) return error("Wait a minute before sending another verification code");
    if (!existing) {
      const countRows = await dbRequest<Array<{ id: string }>>(
        env,
        `account_recovery_methods?owner_id=eq.${encodeURIComponent(user.id)}&select=id&limit=6`,
      );
      if (countRows.length >= 5) return error("You can add up to five recovery emails");
    }
    const code = recoveryCode();
    const now = new Date().toISOString();
    const patch: JsonRecord = {
      email,
      verification_code_hash: await sha256Hex(new TextEncoder().encode(code)),
      verification_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      verification_attempts: 0,
      last_sent_at: now,
      updated_at: now,
    };
    const rows = existing
      ? await dbRequest<RecoveryMethodRow[]>(env, `account_recovery_methods?id=eq.${encodeURIComponent(existing.id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) })
      : await dbRequest<RecoveryMethodRow[]>(env, "account_recovery_methods", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, ...patch }) });
    await sendViaBrevo(env, {
      fromAddress: await defaultFromAddress(env, user.id),
      to: [email],
      subject: "Verify your Parcel recovery email",
      text: `Your Parcel recovery email verification code is ${code}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
      html: `<p>Your Parcel recovery email verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 15 minutes. If you did not request this, you can ignore this email.</p>`,
    });
    return json(recoveryMethodView(rows[0] || { ...(existing || {}), ...patch, id: existing?.id || "", owner_id: user.id } as RecoveryMethodRow), existing ? 200 : 201);
  }
  const recoveryVerifyMatch = url.pathname.match(/^\/api\/recovery-methods\/([^/]+)\/verify$/);
  if (request.method === "POST" && recoveryVerifyMatch) {
    const rows = await dbRequest<RecoveryMethodRow[]>(
      env,
      `account_recovery_methods?id=eq.${encodeURIComponent(recoveryVerifyMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`,
    );
    const method = rows[0];
    if (!method) return error("Recovery email not found", 404);
    if (method.verified_at) return json(recoveryMethodView(method));
    if (!method.verification_expires_at || new Date(method.verification_expires_at).getTime() <= Date.now()) return error("That code has expired. Send a new one.");
    if (method.verification_attempts >= 5) return error("Too many attempts. Send a new code.");
    const body = (await request.json()) as JsonRecord;
    const code = String(body.code || "").replace(/\D/g, "");
    if (code.length !== 6) return error("Enter the six-digit code");
    const candidate = await sha256Hex(new TextEncoder().encode(code));
    if (candidate !== method.verification_code_hash) {
      await dbRequest(env, `account_recovery_methods?id=eq.${encodeURIComponent(method.id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ verification_attempts: method.verification_attempts + 1, updated_at: new Date().toISOString() }) });
      return error("That code is not correct");
    }
    const verifiedRows = await dbRequest<RecoveryMethodRow[]>(env, `account_recovery_methods?id=eq.${encodeURIComponent(method.id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ verified_at: new Date().toISOString(), verification_code_hash: null, verification_expires_at: null, verification_attempts: 0, updated_at: new Date().toISOString() }) });
    return json(recoveryMethodView(verifiedRows[0] || { ...method, verified_at: new Date().toISOString() }));
  }
  const recoveryMethodMatch = url.pathname.match(/^\/api\/recovery-methods\/([^/]+)$/);
  if (request.method === "DELETE" && recoveryMethodMatch) {
    await dbRequest(env, `account_recovery_methods?id=eq.${encodeURIComponent(recoveryMethodMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE" });
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/mailboxes") return json(await dbRequest<Mailbox[]>(env, `mailboxes?owner_id=eq.${encodeURIComponent(user.id)}&order=is_default.desc,created_at.asc`));
  if (request.method === "POST" && url.pathname === "/api/mailboxes") {
    const body = (await request.json()) as JsonRecord;
    if (body.domainId || body.domain_id) {
      const created = await handlePlatformApi(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) }), env, user, (path, init) => dbRequest(env, path, init));
      if (created) return created;
    }
    if (user.id !== env.OWNER_USER_ID) return error("Create mailboxes on a verified domain", 400, "DOMAIN_NOT_VERIFIED");
    const address = cleanAddress(String(body.address || ""));
    if (!address.includes("@")) return error("Enter a valid email address");
    const rows = await dbRequest<Mailbox[]>(env, "mailboxes", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, address, display_name: String(body.displayName || address.split("@")[0]), is_default: false, local_part: address.split("@")[0], status: "active" }) });
    return json(rows[0], 201);
  }
  const mailboxMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)$/);
  if (request.method === "PATCH" && mailboxMatch) { const body = (await request.json()) as JsonRecord; const patch: JsonRecord = {}; for (const key of ["display_name", "can_send", "can_receive", "is_default", "reply_to", "settings"]) if (key in body) patch[key] = body[key]; const rows = await dbRequest<JsonRecord[]>(env, `mailboxes?id=eq.${encodeURIComponent(mailboxMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }); return json(rows[0] || null); }

  if (request.method === "POST" && url.pathname === "/api/trash/empty") {
    let deleted = 0;
    while (true) {
      const rows = await dbRequest<Array<{ id: string }>>(
        env,
        `messages?owner_id=eq.${encodeURIComponent(user.id)}&folder=eq.trash&select=id&limit=100`,
      );
      if (!rows.length) break;
      for (const row of rows) {
        await permanentlyDeleteMessage(env, user.id, row.id);
        deleted += 1;
      }
      if (rows.length < 100) break;
    }
    return json({ ok: true, deleted });
  }

  if (request.method === "GET" && url.pathname === "/api/search/parse") {
    try {
      const parsed = parseSearchQuery(url.searchParams.get("q") || "");
      return json({ ok: true, ...parsed });
    } catch (parseError) {
      return error(parseError instanceof Error ? parseError.message : "Invalid search query", 400);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/saved-searches") {
    const rows = await dbRequest<JsonRecord[]>(env, `saved_searches?owner_id=eq.${encodeURIComponent(user.id)}&order=sort_order.asc,name.asc`);
    if (url.searchParams.get("counts") !== "true") return json(rows);
    const withCounts = await Promise.all(rows.map(async (row) => {
      try {
        const query = await buildMailQuery(env, user.id, { folder: "all", query: String(row.query || ""), page: 1, pageSize: 1 });
        return { ...row, result_count: await dbRequestCount(env, query.path) };
      } catch {
        return { ...row, result_count: null };
      }
    }));
    return json(withCounts);
  }
  if (request.method === "POST" && url.pathname === "/api/saved-searches") {
    const body = (await request.json()) as JsonRecord;
    const name = String(body.name || "").trim().slice(0, 80);
    const queryText = String(body.query || "").trim().slice(0, 1000);
    if (!name) return error("Saved search name is required");
    if (!queryText) return error("Saved search query is required");
    try { parseSearchQuery(queryText); } catch (parseError) { return error(parseError instanceof Error ? parseError.message : "Invalid search query", 400); }
    const color = typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : "#3156d8";
    const rows = await dbRequest<JsonRecord[]>(env, "saved_searches", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, name, query: queryText, color, sort_order: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0 }) });
    return json(rows[0] || null, 201);
  }
  const savedSearchMatch = url.pathname.match(/^\/api\/saved-searches\/([^/]+)$/);
  if (savedSearchMatch && request.method === "PATCH") {
    const body = (await request.json()) as JsonRecord;
    const patch: JsonRecord = { updated_at: new Date().toISOString() };
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
    if (typeof body.query === "string" && body.query.trim()) {
      const queryText = body.query.trim().slice(0, 1000);
      try { parseSearchQuery(queryText); } catch (parseError) { return error(parseError instanceof Error ? parseError.message : "Invalid search query", 400); }
      patch.query = queryText;
    }
    if (typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)) patch.color = body.color;
    if (typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)) patch.sort_order = body.sortOrder;
    const rows = await dbRequest<JsonRecord[]>(env, `saved_searches?id=eq.${encodeURIComponent(savedSearchMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    return json(rows[0] || null);
  }
  if (savedSearchMatch && request.method === "DELETE") {
    await dbRequest(env, `saved_searches?id=eq.${encodeURIComponent(savedSearchMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE" });
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/saved-searches/reorder") {
    const body = (await request.json()) as JsonRecord;
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String).filter(Boolean))].slice(0, 100) : [];
    const existing = await dbRequest<Array<{ id: string }>>(env, `saved_searches?owner_id=eq.${encodeURIComponent(user.id)}&select=id`);
    const allowed = new Set(existing.map((row) => row.id));
    await Promise.all(ids.filter((id) => allowed.has(id)).map((id, index) => dbRequest(env, `saved_searches?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ sort_order: index, updated_at: new Date().toISOString() }) })));
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/mail") {
    try {
      const query = await buildMailQuery(env, user.id, { folder: url.searchParams.get("folder") || "inbox", query: url.searchParams.get("q") || "", filter: url.searchParams.get("filter") || "all", sort: url.searchParams.get("sort") || "newest", page: Number(url.searchParams.get("page") || 1), pageSize: Number(url.searchParams.get("page_size") || url.searchParams.get("limit") || 80) });
      const rows = await dbRequest<JsonRecord[]>(env, query.path);
      const hasMore = rows.length > query.pageSize;
      const items = hasMore ? rows.slice(0, query.pageSize) : rows;
      if (url.searchParams.get("meta") === "true") {
        const total = await dbRequestCount(env, query.path);
        return json({ items, total, page: query.page, pageSize: query.pageSize, hasMore, normalizedQuery: query.parsed?.normalized || "" });
      }
      return json(items);
    } catch (searchError) {
      return error(searchError instanceof Error ? searchError.message : "Search failed", 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/mail/bulk/undo") {
    const body = (await request.json()) as JsonRecord;
    const requestId = String(body.requestId || "").trim();
    if (!requestId || requestId.length > 100) return error("Undo request is invalid");
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const audits = await dbRequest<Array<{ message_id?: string; action_type?: string; before_state?: JsonRecord; created_at?: string }>>(
      env,
      `message_audit_log?owner_id=eq.${encodeURIComponent(user.id)}&request_id=eq.${encodeURIComponent(requestId)}&created_at=gte.${encodeURIComponent(cutoff)}&select=message_id,action_type,before_state,created_at&limit=500`,
    );
    const actionable = audits.filter((audit) => audit.action_type?.startsWith("bulk_") && audit.action_type !== "bulk_undo" && audit.message_id);
    if (!actionable.length) return error("This action can no longer be undone", 410);
    if (actionable.some((audit) => audit.action_type === "bulk_label" || audit.action_type === "bulk_create_task")) return error("This action cannot be undone", 409);
    const undoneIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const audit of actionable) {
      const id = String(audit.message_id);
      try {
        const before = objectValue(audit.before_state);
        const patch: JsonRecord = {};
        for (const key of ["folder", "custom_folder_id", "previous_folder", "is_read", "is_starred", "is_pinned", "is_flagged", "priority", "work_state", "follow_up_at", "snoozed_until"]) if (key in before) patch[key] = before[key];
        await dbRequest(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
        await dbRequest(env, "message_audit_log", { method: "POST", body: JSON.stringify({ owner_id: user.id, actor_id: user.id, message_id: id, action_type: "bulk_undo", target_type: "message", target_id: id, before_state: {}, after_state: patch, request_id: requestId }) });
        undoneIds.push(id);
      } catch (undoError) {
        failures.push({ id, error: undoError instanceof Error ? undoError.message : "Undo failed" });
      }
    }
    return json({ ok: failures.length === 0, undoneIds, failures });
  }

  if (request.method === "POST" && url.pathname === "/api/mail/bulk") {
    const body = (await request.json()) as JsonRecord;
    const action = objectValue(body.action);
    const actionType = String(action.type || "");
    const allowedActions = new Set(["archive", "move", "label", "mark_read", "mark_unread", "star", "unstar", "pin", "unpin", "flag", "unflag", "priority", "snooze", "reply_later", "waiting_on", "i_owe", "spam", "trash", "restore", "export", "create_task"]);
    if (!allowedActions.has(actionType)) return error(`Unsupported bulk action "${actionType}"`);
    const requestId = String(body.idempotencyKey || crypto.randomUUID()).trim().slice(0, 100);
    const replay = await dbRequest<Array<{ message_id?: string }>>(env, `message_audit_log?owner_id=eq.${encodeURIComponent(user.id)}&request_id=eq.${encodeURIComponent(requestId)}&action_type=like.bulk_*&select=message_id&limit=500`).catch(() => []);
    if (replay.length) return json({ ok: true, replayed: true, requestId, changedIds: [...new Set(replay.map((row) => String(row.message_id || "")).filter(Boolean))], failures: [] });
    const scope = body.scope === "all_results" ? "all_results" : "selected";
    const failures: Array<{ id: string; error: string }> = [];
    let rows: JsonRecord[] = [];
    let truncated = false;
    if (scope === "selected") {
      const requested = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(String).filter(Boolean))].slice(0, 100) : [];
      const ids = requested.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      requested.filter((id) => !ids.includes(id)).forEach((id) => failures.push({ id, error: "Invalid message id" }));
      if (!ids.length) return error("Select at least one message");
      rows = await dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(user.id)}&id=${encodeURIComponent(`in.(${ids.join(",")})`)}&select=id,thread_id,mailbox_id,folder,custom_folder_id,previous_folder,is_read,is_starred,is_pinned,is_flagged,priority,work_state,follow_up_at,snoozed_until,subject,from_address,to_addresses,snippet,text_body&limit=100`);
      const found = new Set(rows.map((row) => String(row.id)));
      ids.filter((id) => !found.has(id)).forEach((id) => failures.push({ id, error: "Message not found or not owned" }));
    } else {
      const query = await buildMailQuery(env, user.id, { folder: String(body.folder || "all"), query: String(body.query || ""), filter: "all", sort: "newest", page: 1, pageSize: 500 });
      const result = await dbRequest<JsonRecord[]>(env, query.path);
      truncated = result.length > 500;
      rows = truncated ? result.slice(0, 500) : result;
    }
    const changedIds: string[] = [];
    const exportRows: JsonRecord[] = [];
    for (const row of rows) {
      try {
        const result = await applyBulkMessageAction(env, user.id, row, action, requestId);
        if (result.changed) changedIds.push(String(row.id));
        if (result.exportRow) exportRows.push(result.exportRow);
      } catch (actionError) {
        failures.push({ id: String(row.id), error: actionError instanceof Error ? actionError.message : "Action failed" });
      }
    }
    return json({ ok: failures.length === 0, requestId, scope, requestedCount: scope === "all_results" ? rows.length : (Array.isArray(body.messageIds) ? body.messageIds.length : 0), changedIds, exported: exportRows, failures, truncated, undoable: ["archive", "move", "mark_read", "mark_unread", "star", "unstar", "pin", "unpin", "flag", "unflag", "priority", "snooze", "reply_later", "waiting_on", "i_owe", "spam", "trash", "restore"].includes(actionType) });
  }

  if (request.method === "GET" && url.pathname === "/api/work") {
    const requestedState = url.searchParams.get("state");
    if (requestedState && !normalizeWorkState(requestedState)) return error("Work state is invalid", 400);
    const stateFilter = requestedState && requestedState !== "none" ? `&work_state=eq.${encodeURIComponent(requestedState)}` : "";
    const rows = await dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(user.id)}&work_state=neq.none${stateFilter}&order=follow_up_at.asc.nullsfirst,created_at.desc&limit=200&select=id,thread_id,mailbox_id,direction,folder,status,from_name,from_address,to_addresses,subject,snippet,is_read,is_starred,is_pinned,is_flagged,priority,has_attachment,work_state,follow_up_at,work_note,received_at,sent_at,created_at`);
    const now = Date.now();
    return json(rows.map((row) => ({ ...row, overdue: Boolean(row.follow_up_at && new Date(String(row.follow_up_at)).getTime() <= now) })));
  }
  if (request.method === "GET" && url.pathname === "/api/work/summary") {
    const rows = await dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(user.id)}&work_state=neq.none&limit=200&select=work_state,follow_up_at`);
    return json(workQueueSummary(rows));
  }
  const workMatch = url.pathname.match(/^\/api\/work\/([^/]+)$/);
  if (workMatch && request.method === "PATCH") {
    const body = (await request.json()) as JsonRecord;
    const existing = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(workMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing[0]) return error("Message not found", 404);
    try {
      const patch = buildWorkStatePatch({ ...body, workState: body.workState ?? existing[0].work_state ?? "none" });
      const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(workMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
      await writeMessageAudit(env, user.id, crypto.randomUUID(), "work_state_change", existing[0], bulkBeforeState(existing[0]), { ...bulkBeforeState(existing[0]), ...patch });
      return json(rows[0] || null);
    } catch (workError) {
      return error(workError instanceof Error ? workError.message : "Work state could not be saved", 400);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/screening/queue") {
    return json(await dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(user.id)}&screening_status=eq.review&order=created_at.asc&limit=100&select=id,thread_id,mailbox_id,direction,folder,status,from_name,from_address,to_addresses,subject,snippet,spam_score,spam_reasons,trust_score,screening_status,has_attachment,received_at,created_at`));
  }
  if (request.method === "GET" && url.pathname === "/api/screening/history") {
    const messageId = url.searchParams.get("messageId") || "";
    if (!messageId) return error("Message id is required");
    const owned = await dbRequest<Array<{ id: string }>>(env, `messages?id=eq.${encodeURIComponent(messageId)}&owner_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`);
    if (!owned[0]) return error("Message not found", 404);
    return json(await dbRequest<JsonRecord[]>(env, `screening_events?owner_id=eq.${encodeURIComponent(user.id)}&message_id=eq.${encodeURIComponent(messageId)}&order=created_at.desc&limit=100`));
  }
  const screeningDecisionMatch = url.pathname.match(/^\/api\/screening\/([^/]+)\/decision$/);
  if (request.method === "POST" && screeningDecisionMatch) {
    const id = screeningDecisionMatch[1];
    const existing = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing[0]) return error("Message not found", 404);
    const body = (await request.json()) as JsonRecord;
    const decision = body.decision === "approve" || body.decision === "block" || body.decision === "reroute" ? body.decision : "";
    if (!decision) return error("Choose approve, block, or reroute");
    const decisionPatch = screeningDecisionPatch(decision, body.folder === "custom" ? "custom" : "archive");
    const { event, ...patch } = decisionPatch;
    if (decision === "reroute" && body.folder === "custom") {
      const customFolderId = String(body.customFolderId || "");
      const folders = await dbRequest<Array<{ id: string }>>(env, `mail_folders?id=eq.${encodeURIComponent(customFolderId)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
      if (!folders[0]) return error("Choose a valid destination folder");
      patch.custom_folder_id = customFolderId;
    }
    await dbRequest(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ ...patch, screening_policy_id: existing[0].screening_policy_id || null, updated_at: new Date().toISOString() }) });
    await dbRequest(env, "screening_events", { method: "POST", body: JSON.stringify({ owner_id: user.id, message_id: id, policy_id: existing[0].screening_policy_id || null, decision: event, previous_folder: existing[0].folder, restored_at: decision === "approve" ? new Date().toISOString() : null }) }).catch(() => undefined);
    return json({ ok: true, messageId: id, decision, folder: patch.folder });
  }

  const messageMatch = url.pathname.match(/^\/api\/mail\/([^/]+)$/);
  const trustMatch = url.pathname.match(/^\/api\/mail\/([^/]+)\/trust$/);
  if (request.method === "GET" && trustMatch) {
    const id = trustMatch[1];
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1&select=id,from_name,from_address,reply_to,subject,spam_score,spam_reasons,trust_score,trust_reasons,trust_evidence,auth_results,auth_spf,auth_dkim,auth_dmarc,auth_arc,auth_tls,received_auth_at,sender_first_seen,known_contact,reply_to_mismatch,link_count,tracking_pixel_count,screening_status,screening_policy_id,created_at`);
    if (!rows[0]) return error("Message not found", 404);
    const events = await dbRequest<JsonRecord[]>(env, `screening_events?owner_id=eq.${encodeURIComponent(user.id)}&message_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=20`).catch(() => []);
    return json({ ...rows[0], screening_history: events });
  }
  const feedbackMatch = url.pathname.match(/^\/api\/mail\/([^/]+)\/feedback$/);
  if (request.method === "POST" && feedbackMatch) {
    const id = feedbackMatch[1];
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!rows[0]) return error("Message not found", 404);
    const body = (await request.json()) as JsonRecord;
    const feedback = body.feedback === "spam" || body.feedback === "not_spam" ? body.feedback : "";
    if (!feedback) return error("Feedback must be spam or not_spam");
    await recordScreeningFeedback(env, user.id, rows[0], feedback);
    const updated = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    return json({ ok: true, feedback, message: updated[0] || null });
  }
  if (request.method === "GET" && messageMatch) { const id = messageMatch[1]; const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`); if (!rows[0]) return error("Message not found", 404); const attachments = await dbRequest<JsonRecord[]>(env, `attachments?message_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&order=created_at.asc`); const labels = await dbRequest<JsonRecord[]>(env, `message_labels?message_id=eq.${encodeURIComponent(id)}&select=label_id`); return json({ ...rows[0], attachments, labels }); }
  if (request.method === "GET" && url.pathname.startsWith("/api/threads/")) { const id = url.pathname.split("/").pop() || ""; return json(await dbRequest(env, `messages?thread_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&order=created_at.asc`)); }
  const outboxCancelMatch = url.pathname.match(/^\/api\/outbox\/([^/]+)\/cancel$/);
  if (request.method === "POST" && outboxCancelMatch) {
    const id = outboxCancelMatch[1];
    const existing = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing[0]) return error("Message not found", 404);
    if (!canManageOutbox(existing[0], user.id)) return error("This send is already being processed or can no longer be cancelled", 409);
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&status=in.(queued,scheduled)&cancelled_at=is.null`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "draft", folder: "drafts", cancelled_at: new Date().toISOString(), send_after: null, send_lease_until: null, scheduled_at: null, work_note: "Send cancelled", updated_at: new Date().toISOString() }) });
    return json({ ok: true, message: rows[0] || null });
  }
  const outboxEditMatch = url.pathname.match(/^\/api\/outbox\/([^/]+)$/);
  if (request.method === "PATCH" && outboxEditMatch) {
    const id = outboxEditMatch[1];
    const existing = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing[0]) return error("Message not found", 404);
    if (!canManageOutbox(existing[0], user.id)) return error("This send is already being processed or can no longer be edited", 409);
    const body = (await request.json()) as JsonRecord;
    const patch: JsonRecord = { updated_at: new Date().toISOString() };
    if (body.to !== undefined) { const recipients = splitAddresses(body.to); if (!recipients.length) return error("At least one recipient is required"); patch.to_addresses = recipients; }
    if (body.cc !== undefined) patch.cc_addresses = splitAddresses(body.cc);
    if (body.bcc !== undefined) patch.bcc_addresses = splitAddresses(body.bcc);
    if (typeof body.subject === "string") { patch.subject = body.subject.slice(0, 500); patch.snippet = snippet(String((body.text ?? existing[0].text_body) || "")); }
    if (typeof body.text === "string") { patch.text_body = body.text; patch.snippet = snippet(body.text); }
    if (typeof body.html === "string") patch.html_body = body.html;
    if (typeof body.replyTo === "string") patch.reply_to = cleanAddress(body.replyTo);
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&status=in.(queued,scheduled)&cancelled_at=is.null`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    return json({ ok: true, message: rows[0] || null });
  }
  if (request.method === "POST" && messageMatch) {
    const id = messageMatch[1]; const body = (await request.json()) as JsonRecord; const existing = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`); if (!existing[0]) return error("Message not found", 404);
    if (body.action === "restore") {
      if (existing[0].folder !== "trash") return error("Only messages in Trash can be restored");
      let target = trashRestoreTarget(existing[0]);
      if (target.folder === "custom") {
        const customFolder = await dbRequest<JsonRecord[]>(env, `mail_folders?id=eq.${encodeURIComponent(target.custom_folder_id || "")}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
        if (!customFolder[0]) target = { folder: "inbox", custom_folder_id: null };
      }
      const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&folder=eq.trash`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ folder: target.folder, custom_folder_id: target.custom_folder_id, previous_folder: null, snoozed_until: null, updated_at: new Date().toISOString() }) });
      await dbRequest(env, "screening_events", { method: "POST", body: JSON.stringify({ owner_id: user.id, message_id: id, decision: "restored", previous_folder: "trash", restored_at: new Date().toISOString() }) }).catch(() => undefined);
      return json(Array.isArray(rows) ? rows[0] : rows);
    }
    if (body.action === "permanent_delete") {
      await permanentlyDeleteMessage(env, user.id, id);
      return json({ ok: true, deleted: id });
    }
    const patch: JsonRecord = {};
    if (typeof body.isRead === "boolean") patch.is_read = body.isRead;
    if (typeof body.isStarred === "boolean") patch.is_starred = body.isStarred;
    if (typeof body.isPinned === "boolean") patch.is_pinned = body.isPinned;
    if (typeof body.isFlagged === "boolean") patch.is_flagged = body.isFlagged;
    if (typeof body.priority === "number") patch.priority = Math.max(0, Math.min(2, body.priority));
    if (body.workState !== undefined || body.followUpAt !== undefined || body.workNote !== undefined) {
      try {
        Object.assign(patch, buildWorkStatePatch({ ...body, workState: body.workState ?? existing[0].work_state ?? "none" }));
      } catch (workError) {
        return error(workError instanceof Error ? workError.message : "Work state could not be saved", 400);
      }
    }
    if (typeof body.snoozedUntil === "string" && body.snoozedUntil) { patch.previous_folder = existing[0].folder; patch.snoozed_until = body.snoozedUntil; patch.folder = "archive"; }
    if (body.snoozedUntil === null) { patch.snoozed_until = null; patch.folder = existing[0].previous_folder || "inbox"; patch.previous_folder = null; }
    if (typeof body.folder === "string" && SYSTEM_FOLDERS.includes(body.folder as typeof SYSTEM_FOLDERS[number])) {
      if (body.folder === "trash" && existing[0].folder !== "trash") {
        patch.previous_folder = existing[0].folder === "custom" && existing[0].custom_folder_id ? `custom:${existing[0].custom_folder_id}` : existing[0].folder;
      }
      if (existing[0].folder === "trash" && body.folder !== "trash") patch.previous_folder = null;
      patch.folder = body.folder;
      patch.custom_folder_id = null;
    }
    if (body.folder === "custom" && typeof body.customFolderId === "string") { patch.folder = "custom"; patch.custom_folder_id = body.customFolderId; }
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    if (body.folder === "spam" || body.folder === "inbox") await recordScreeningFeedback(env, user.id, { ...existing[0], folder: body.folder }, body.folder === "spam" ? "spam" : "not_spam");
    return json(Array.isArray(rows) ? rows[0] : rows);
  }

  if (request.method === "GET" && url.pathname === "/api/folders") return json(await dbRequest(env, `mail_folders?owner_id=eq.${encodeURIComponent(user.id)}&order=sort_order.asc,name.asc`));
  if (request.method === "POST" && url.pathname === "/api/folders") { const body = (await request.json()) as JsonRecord; const name = String(body.name || "").trim(); if (!name) return error("Folder name is required"); const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); const rows = await dbRequest<JsonRecord[]>(env, "mail_folders", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, name, slug, color: String(body.color || "#6f7d91") }) }); return json(rows[0], 201); }
  if (request.method === "GET" && url.pathname === "/api/labels") return json(await dbRequest(env, `labels?owner_id=eq.${encodeURIComponent(user.id)}&order=name.asc`));
  if (request.method === "POST" && url.pathname === "/api/labels") { const body = (await request.json()) as JsonRecord; const rows = await dbRequest<JsonRecord[]>(env, "labels", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, name: String(body.name || "Untitled"), color: String(body.color || "#2d5bff") }) }); return json(rows[0], 201); }
  if (request.method === "POST" && url.pathname === "/api/labels/assign") { const body = (await request.json()) as JsonRecord; const labelId = String(body.labelId || ""); const messageId = String(body.messageId || ""); if (!labelId || !messageId) return error("Message and label are required"); await dbRequest(env, "message_labels", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ message_id: messageId, label_id: labelId }) }); return json({ ok: true }); }
  if (request.method === "GET" && url.pathname === "/api/contacts") { const q = url.searchParams.get("q")?.trim(); const path = `contacts?owner_id=eq.${encodeURIComponent(user.id)}&order=display_name.asc${q ? `&or=${encodeURIComponent(`email.ilike.*${q}*,display_name.ilike.*${q}*`)}` : ""}`; return json(await dbRequest(env, path)); }
  if (request.method === "POST" && url.pathname === "/api/contacts") { const body = (await request.json()) as JsonRecord; const email = cleanAddress(String(body.email || "")); if (!email.includes("@")) return error("A valid email is required"); const avatarUrl = typeof body.avatarUrl === "string" && body.avatarUrl.trim() ? body.avatarUrl.trim() : null; if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) return error("Profile image URL must use https://"); const rows = await dbRequest<JsonRecord[]>(env, "contacts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, email, display_name: String(body.displayName || email.split("@")[0]), avatar_url: avatarUrl, company: body.company || null, notes: body.notes || null }) }); return json(rows[0], 201); }
  if (request.method === "GET" && url.pathname === "/api/sender-policies") return json(await dbRequest<SenderPolicy[]>(env, `sender_policies?owner_id=eq.${encodeURIComponent(user.id)}&order=enabled.desc,match_type.asc,match_value.asc`).catch(() => []));
  if (request.method === "POST" && url.pathname === "/api/sender-policies") {
    const body = (await request.json()) as JsonRecord;
    const matchType = body.matchType === "domain" ? "domain" : body.matchType === "address" ? "address" : "";
    const action = String(body.action || "");
    if (!matchType || !SENDER_POLICY_ACTIONS.has(action)) return error("Choose a sender or domain and a valid action");
    let matchValue = "";
    try { matchValue = normalizeSenderPolicyValue(matchType, body.matchValue); } catch (policyError) { return error(policyError instanceof Error ? policyError.message : "Sender policy is invalid"); }
    const mailboxId = await ensurePolicyMailbox(env, user.id, body.mailboxId);
    const targetFolderId = typeof body.targetFolderId === "string" && body.targetFolderId ? body.targetFolderId : null;
    if (action === "folder") {
      if (!targetFolderId) return error("Choose a destination folder");
      const target = await dbRequest<Array<{ id: string }>>(env, `mail_folders?id=eq.${encodeURIComponent(targetFolderId)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
      if (!target[0]) return error("Destination folder not found", 404);
    }
    try {
      const rows = await dbRequest<SenderPolicy[]>(env, "sender_policies", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, mailbox_id: mailboxId, match_type: matchType, match_value: matchValue, action, target_folder_id: targetFolderId, enabled: true }) });
      return json(rows[0], 201);
    } catch (policyError) {
      return error(policyError instanceof Error ? policyError.message : "That sender policy already exists", 409);
    }
  }
  const senderPolicyMatch = url.pathname.match(/^\/api\/sender-policies\/([^/]+)$/);
  if (senderPolicyMatch && request.method === "PATCH") {
    const body = (await request.json()) as JsonRecord;
    const existing = await dbRequest<SenderPolicy[]>(env, `sender_policies?id=eq.${encodeURIComponent(senderPolicyMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing[0]) return error("Sender policy not found", 404);
    const matchType = body.matchType === "domain" || body.matchType === "address" ? body.matchType : existing[0].match_type;
    const action = typeof body.action === "string" ? body.action : existing[0].action;
    if (!SENDER_POLICY_ACTIONS.has(action)) return error("Choose a valid sender policy action");
    let matchValue = existing[0].match_value;
    try { if (body.matchValue !== undefined || body.matchType !== undefined) matchValue = normalizeSenderPolicyValue(matchType, body.matchValue ?? existing[0].match_value); } catch (policyError) { return error(policyError instanceof Error ? policyError.message : "Sender policy is invalid"); }
    const patch: JsonRecord = { updated_at: new Date().toISOString(), match_type: matchType, match_value: matchValue, action };
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.mailboxId !== undefined) patch.mailbox_id = await ensurePolicyMailbox(env, user.id, body.mailboxId);
    if (body.targetFolderId !== undefined) patch.target_folder_id = typeof body.targetFolderId === "string" && body.targetFolderId ? body.targetFolderId : null;
    if (action === "folder") {
      const targetFolderId = String(patch.target_folder_id ?? existing[0].target_folder_id ?? "");
      if (!targetFolderId) return error("Choose a destination folder");
      const target = await dbRequest<Array<{ id: string }>>(env, `mail_folders?id=eq.${encodeURIComponent(targetFolderId)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
      if (!target[0]) return error("Destination folder not found", 404);
      patch.target_folder_id = targetFolderId;
    } else if (body.targetFolderId === undefined) patch.target_folder_id = null;
    try {
      const rows = await dbRequest<SenderPolicy[]>(env, `sender_policies?id=eq.${encodeURIComponent(senderPolicyMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
      return json(rows[0] || null);
    } catch (policyError) {
      return error(policyError instanceof Error ? policyError.message : "Sender policy could not be updated", 409);
    }
  }
  if (senderPolicyMatch && request.method === "DELETE") {
    await dbRequest(env, `sender_policies?id=eq.${encodeURIComponent(senderPolicyMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE" });
    return json({ ok: true });
  }
  const senderPolicyApplyMatch = url.pathname.match(/^\/api\/sender-policies\/([^/]+)\/apply-existing$/);
  if (request.method === "POST" && senderPolicyApplyMatch) {
    const body = (await request.json()) as JsonRecord;
    if (body.confirm !== true) return error("Explicit confirmation is required before applying a policy to existing messages");
    const policies = await dbRequest<SenderPolicy[]>(env, `sender_policies?id=eq.${encodeURIComponent(senderPolicyApplyMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const policy = policies[0];
    if (!policy) return error("Sender policy not found", 404);
    const rows = await dbRequest<JsonRecord[]>(env, `messages?owner_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=500&select=id,mailbox_id,from_address,folder,custom_folder_id`);
    const matching = rows.filter((message) => policyMatchesMessage(policy, message));
    const failures: Array<{ id: string; error: string }> = [];
    for (const message of matching) {
      try { await applyPolicyToMessage(env, user.id, message, policy); } catch (applyError) { failures.push({ id: String(message.id), error: applyError instanceof Error ? applyError.message : "Could not apply policy" }); }
    }
    return json({ ok: failures.length === 0, matched: matching.length, changed: matching.length - failures.length, failures, capped: rows.length === 500 });
  }
  if (request.method === "GET" && url.pathname === "/api/rules/export") {
    const rows = await dbRequest<JsonRecord[]>(env, `mail_rules?owner_id=eq.${encodeURIComponent(user.id)}&order=priority.asc,created_at.asc`);
    const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), rules: rows.map((row) => normalizeRuleRecord(row)) };
    return new Response(JSON.stringify(payload, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": "attachment; filename=parcel-rules.json", "cache-control": "no-store" } });
  }
  if (request.method === "POST" && url.pathname === "/api/rules/import") {
    const body = (await request.json()) as JsonRecord;
    if (Number(body.schemaVersion || 0) !== 1 || !Array.isArray(body.rules)) return error("This rules file is not supported", 400);
    const imported = body.rules.slice(0, 100);
    const created: JsonRecord[] = [];
    const failures: Array<{ index: number; error: string }> = [];
    for (const [index, value] of imported.entries()) {
      const normalized = normalizeRuleRecord(objectValue(value));
      const validation = validateRuleInput(normalized);
      if (validation.length) { failures.push({ index, error: validation.join("; ") }); continue; }
      try {
        const rows = await dbRequest<JsonRecord[]>(env, "mail_rules", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, name: normalized.name, priority: normalized.priority, enabled: normalized.enabled, conditions: normalized.conditions, actions: normalized.actions }) });
        if (rows[0]) created.push(rows[0]);
      } catch (importError) {
        failures.push({ index, error: importError instanceof Error ? importError.message : "Could not import rule" });
      }
    }
    return json({ ok: failures.length === 0, imported: created.length, failures, rules: created }, failures.length && !created.length ? 400 : 200);
  }
  if (request.method === "GET" && url.pathname === "/api/rule-runs") {
    const ruleId = url.searchParams.get("ruleId");
    const ruleFilter = ruleId ? `&rule_id=eq.${encodeURIComponent(ruleId)}` : "";
    return json(await dbRequest(env, `mail_rule_runs?owner_id=eq.${encodeURIComponent(user.id)}${ruleFilter}&order=started_at.desc&limit=50`));
  }
  if (request.method === "GET" && url.pathname === "/api/audit-log") {
    const messageId = url.searchParams.get("messageId");
    return json(await dbRequest(env, `message_audit_log?owner_id=eq.${encodeURIComponent(user.id)}${messageId ? `&message_id=eq.${encodeURIComponent(messageId)}` : ""}&order=created_at.desc&limit=100`));
  }
  if (request.method === "GET" && url.pathname === "/api/rules") return json(await dbRequest(env, `mail_rules?owner_id=eq.${encodeURIComponent(user.id)}&order=priority.asc,created_at.asc`));
  if (request.method === "POST" && url.pathname === "/api/rules") {
    const body = (await request.json()) as JsonRecord;
    const normalized = normalizeRuleRecord({ ...body, conditions: buildRuleConditions(body.conditions, body.exceptions) });
    const validation = validateRuleInput(normalized);
    if (validation.length) return error(validation.join("; "), 400);
    const rows = await dbRequest<JsonRecord[]>(env, "mail_rules", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: user.id,
        name: normalized.name,
        priority: normalized.priority,
        enabled: normalized.enabled,
        conditions: normalized.conditions,
        actions: normalized.actions,
      }),
    });
    return json(rows[0], 201);
  }
  const ruleActionMatch = url.pathname.match(/^\/api\/rules\/([^/]+)\/(preview|dry-run|apply|conflicts)$/);
  if (ruleActionMatch && (request.method === "POST" || (request.method === "GET" && ruleActionMatch[2] === "conflicts"))) {
    const ruleId = ruleActionMatch[1];
    const action = ruleActionMatch[2];
    const rows = await dbRequest<Rule[]>(env, `mail_rules?id=eq.${encodeURIComponent(ruleId)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!rows[0]) return error("Rule not found", 404);
    const rule = rows[0];
    const allRules = await dbRequest<Rule[]>(env, `mail_rules?owner_id=eq.${encodeURIComponent(user.id)}&order=priority.asc,created_at.asc`);
    const conflicts = ruleConflicts(rule, allRules);
    if (action === "conflicts") return json({ ruleId, conflicts });
    const sourceRows = await existingRuleMessages(env, user.id);
    const analysis = matchRuleMessages(sourceRows, rule);
    if (action === "preview" || action === "dry-run") {
      const runId = await createRuleRun(env, user.id, rule.id, action === "preview" ? "preview" : "dry_run", analysis.matches);
      await finishRuleRun(env, user.id, runId, { status: "completed", matched_count: analysis.matches.length, changed_count: 0, sample: analysis.matches.slice(0, 20) });
      return json({ ok: true, runId, mode: action === "preview" ? "preview" : "dry_run", matchedCount: analysis.matches.length, changedCount: 0, matches: analysis.matches.slice(0, 50), impact: ruleImpactText(analysis.impact), conflicts });
    }
    const body = (await request.json()) as JsonRecord;
    const suppliedRunId = typeof body.runId === "string" ? body.runId : "";
    let runId = suppliedRunId;
    if (runId) {
      const runRows = await dbRequest<Array<{ id: string; rule_id: string; mode: string }>>(env, `mail_rule_runs?id=eq.${encodeURIComponent(runId)}&owner_id=eq.${encodeURIComponent(user.id)}&rule_id=eq.${encodeURIComponent(rule.id)}&limit=1`);
      if (!runRows[0] || !["preview", "dry_run"].includes(runRows[0].mode)) return error("Run preview or dry-run before applying this rule", 409);
      await dbRequest(env, `mail_rule_runs?id=eq.${encodeURIComponent(runId)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ mode: "apply", status: "started" }) });
    } else runId = await createRuleRun(env, user.id, rule.id, "apply", analysis.matches);
    const blockingConflicts = conflicts.filter((conflict) => conflict.severity === "error");
    if (blockingConflicts.length) {
      await finishRuleRun(env, user.id, runId, { status: "failed", error_message: blockingConflicts.map((conflict) => conflict.message).join(" ") });
      return json({ ok: false, runId, conflicts }, 409);
    }
    const result = await applyExistingRuleMatches(env, user.id, rule, runId, analysis.matches, sourceRows);
    await finishRuleRun(env, user.id, runId, { status: result.failures.length ? "failed" : "completed", matched_count: analysis.matches.length, changed_count: result.changedCount, sample: analysis.matches.slice(0, 20), error_message: result.failures[0]?.error || null });
    await dbRequest(env, `mail_rules?id=eq.${encodeURIComponent(rule.id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ last_run_at: new Date().toISOString(), last_run_count: result.changedCount, last_error: result.failures[0]?.error || null }) });
    return json({ ok: result.failures.length === 0, runId, mode: "apply", matchedCount: analysis.matches.length, changedCount: result.changedCount, failures: result.failures, conflicts, undoable: result.changedCount > 0 });
  }
  const ruleRunsMatch = url.pathname.match(/^\/api\/rules\/([^/]+)\/runs$/);
  if (ruleRunsMatch && request.method === "GET") {
    const exists = await dbRequest<Array<{ id: string }>>(env, `mail_rules?id=eq.${encodeURIComponent(ruleRunsMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!exists[0]) return error("Rule not found", 404);
    return json(await dbRequest(env, `mail_rule_runs?owner_id=eq.${encodeURIComponent(user.id)}&rule_id=eq.${encodeURIComponent(ruleRunsMatch[1])}&order=started_at.desc&limit=50`));
  }
  const ruleRunUndoMatch = url.pathname.match(/^\/api\/rule-runs\/([^/]+)\/undo$/);
  if (ruleRunUndoMatch && request.method === "POST") {
    const runRows = await dbRequest<Array<{ id: string; rule_id: string; mode: string; status: string; completed_at?: string }>>(env, `mail_rule_runs?id=eq.${encodeURIComponent(ruleRunUndoMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const run = runRows[0];
    if (!run || run.mode !== "apply") return error("This rule run cannot be undone", 409);
    if (run.completed_at && new Date(run.completed_at).getTime() < Date.now() - 30_000) return error("Rule undo is available for 30 seconds", 410);
    const audits = await dbRequest<Array<{ message_id?: string; before_state?: JsonRecord; after_state?: JsonRecord }>>(env, `message_audit_log?owner_id=eq.${encodeURIComponent(user.id)}&request_id=eq.${encodeURIComponent(`rule-run:${run.id}`)}&action_type=eq.rule_apply&limit=500`);
    if (!audits.length) return error("No message changes were recorded for this run", 410);
    const undoneIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const audit of audits) {
      const id = String(audit.message_id || "");
      if (!id) continue;
      try {
        const before = objectValue(audit.before_state);
        const after = objectValue(audit.after_state);
        const patch: JsonRecord = {};
        for (const key of ["folder", "custom_folder_id", "previous_folder", "is_read", "is_starred", "is_pinned", "is_flagged", "priority", "work_state", "follow_up_at", "snoozed_until"]) if (key in before) patch[key] = before[key];
        await dbRequest(env, `messages?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
        const addedLabelIds = Array.isArray(after.added_label_ids) ? after.added_label_ids.map(String).filter(Boolean) : [];
        for (const labelId of addedLabelIds) await dbRequest(env, `message_labels?message_id=eq.${encodeURIComponent(id)}&label_id=eq.${encodeURIComponent(labelId)}`, { method: "DELETE" });
        const message = { id, mailbox_id: null, thread_id: null };
        await writeMessageAudit(env, user.id, `rule-run:${run.id}`, "rule_undo", message, {}, patch);
        undoneIds.push(id);
      } catch (undoError) {
        failures.push({ id, error: undoError instanceof Error ? undoError.message : "Could not undo rule" });
      }
    }
    await finishRuleRun(env, user.id, run.id, { status: "cancelled", changed_count: 0, error_message: failures[0]?.error || null });
    return json({ ok: failures.length === 0, undoneIds, failures });
  }
  const ruleMatch = url.pathname.match(/^\/api\/rules\/([^/]+)$/);
  if (ruleMatch && request.method === "PATCH") {
    const body = (await request.json()) as JsonRecord;
    const existing = await dbRequest<JsonRecord[]>(env, `mail_rules?id=eq.${encodeURIComponent(ruleMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing[0]) return error("Rule not found", 404);
    const candidateConditions = body.conditions !== undefined || body.exceptions !== undefined
      ? buildRuleConditions(body.conditions ?? existing[0].conditions, body.exceptions ?? objectValue(existing[0].conditions).exceptions)
      : existing[0].conditions;
    const candidate = normalizeRuleRecord({ name: body.name ?? existing[0].name, priority: body.priority ?? existing[0].priority, enabled: body.enabled ?? existing[0].enabled, conditions: candidateConditions, actions: body.actions ?? existing[0].actions });
    const validation = validateRuleInput(candidate);
    if (validation.length) return error(validation.join("; "), 400);
    const patch: JsonRecord = { updated_at: new Date().toISOString() };
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.priority === "number" && Number.isFinite(body.priority)) patch.priority = body.priority;
    if (body.conditions !== undefined || body.exceptions !== undefined) patch.conditions = candidate.conditions;
    if (body.actions !== undefined) patch.actions = objectValue(body.actions);
    const rows = await dbRequest<JsonRecord[]>(env, `mail_rules?id=eq.${encodeURIComponent(ruleMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    return json(rows[0] || null);
  }
  if (ruleMatch && request.method === "DELETE") {
    const rows = await dbRequest<JsonRecord[]>(env, `mail_rules?id=eq.${encodeURIComponent(ruleMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
    return json({ ok: true, deleted: rows.length });
  }
  if (ruleMatch && request.method === "POST" && ruleMatch[1].endsWith(":run")) {
    const ruleId = ruleMatch[1].slice(0, -4);
    const rows = await dbRequest<Rule[]>(env, `mail_rules?id=eq.${encodeURIComponent(ruleId)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!rows[0]) return error("Rule not found", 404);
    const sourceRows = await existingRuleMessages(env, user.id);
    const analysis = matchRuleMessages(sourceRows, rows[0]);
    const runId = await createRuleRun(env, user.id, rows[0].id, "apply", analysis.matches);
    const result = await applyExistingRuleMatches(env, user.id, rows[0], runId, analysis.matches, sourceRows);
    await finishRuleRun(env, user.id, runId, { status: result.failures.length ? "failed" : "completed", matched_count: analysis.matches.length, changed_count: result.changedCount, error_message: result.failures[0]?.error || null });
    return json({ ok: result.failures.length === 0, runId, matched: analysis.matches.length, changed: result.changedCount, failures: result.failures, note: rows[0].actions?.forwardTo ? "Forwarding is skipped when running a rule on existing mail." : undefined });
  }
  if (request.method === "POST" && url.pathname === "/api/rules/reorder") {
    const body = (await request.json()) as JsonRecord;
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    const existing = await dbRequest<Array<{ id: string }>>(env, `mail_rules?owner_id=eq.${encodeURIComponent(user.id)}&select=id`);
    const allowed = new Set(existing.map((row) => row.id));
    const ordered = ids.filter((id) => allowed.has(id));
    await Promise.all(ordered.map((id, index) => dbRequest(env, `mail_rules?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ priority: (index + 1) * 100, updated_at: new Date().toISOString() }) })));
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/signatures") return json(await dbRequest(env, `signatures?owner_id=eq.${encodeURIComponent(user.id)}&order=name.asc`));
  if (request.method === "POST" && url.pathname === "/api/signatures") { const body = (await request.json()) as JsonRecord; const rows = await dbRequest<JsonRecord[]>(env, "signatures", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, mailbox_id: body.mailboxId || mailbox.id || null, name: String(body.name || "Default"), text_body: String(body.text || ""), html_body: typeof body.html === "string" ? body.html : null, is_default: body.isDefault === true }) }); return json(rows[0], 201); }
  if (request.method === "GET" && url.pathname === "/api/settings") { const rows = await dbRequest<JsonRecord[]>(env, `user_settings?owner_id=eq.${encodeURIComponent(user.id)}&limit=1`); return json({ ...(rows[0] || { owner_id: user.id }), send_undo_seconds: normalizeUndoSeconds(objectValue(mailbox.settings).send_undo_seconds, 0) }); }
  if (request.method === "PATCH" && url.pathname === "/api/settings") { const body = (await request.json()) as JsonRecord; const allowed = ["theme", "density", "reading_pane", "language", "timezone", "focused_inbox_enabled", "desktop_notifications", "push_subscription"]; const patch: JsonRecord = { updated_at: new Date().toISOString() }; for (const key of allowed) if (key in body) patch[key] = body[key]; let undoSeconds = normalizeUndoSeconds(objectValue(mailbox.settings).send_undo_seconds, 0); if ("send_undo_seconds" in body) { undoSeconds = normalizeUndoSeconds(body.send_undo_seconds, undoSeconds); const currentMailboxSettings = objectValue(mailbox.settings); if (mailbox.id) await dbRequest(env, `mailboxes?id=eq.${encodeURIComponent(mailbox.id)}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ settings: { ...currentMailboxSettings, send_undo_seconds: undoSeconds } }) }); } const rows = await dbRequest<JsonRecord[]>(env, `user_settings?owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }); return json({ ...(rows[0] || patch), send_undo_seconds: undoSeconds }); }
  if (request.method === "GET" && url.pathname === "/api/calendar") return json(await dbRequest(env, `calendar_events?owner_id=eq.${encodeURIComponent(user.id)}&order=starts_at.asc`));
  if (request.method === "POST" && url.pathname === "/api/calendar") { const body = (await request.json()) as JsonRecord; const rows = await dbRequest<JsonRecord[]>(env, "calendar_events", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, title: String(body.title || "Untitled event"), description: String(body.description || ""), location: body.location || null, starts_at: body.startsAt, ends_at: body.endsAt, all_day: body.allDay === true, attendees: body.attendees || [] }) }); return json(rows[0], 201); }
  const calendarMatch = url.pathname.match(/^\/api\/calendar\/([^/]+)$/);
  if (request.method === "PATCH" && calendarMatch) { const body = (await request.json()) as JsonRecord; const patch: JsonRecord = { updated_at: new Date().toISOString() }; for (const key of ["title", "description", "location", "starts_at", "ends_at", "all_day", "attendees"]) if (key in body) patch[key] = body[key]; const rows = await dbRequest<JsonRecord[]>(env, `calendar_events?id=eq.${encodeURIComponent(calendarMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }); return json(rows[0] || null); }
  if (request.method === "GET" && url.pathname === "/api/tasks") return json(await dbRequest(env, `tasks?owner_id=eq.${encodeURIComponent(user.id)}&order=completed.asc,due_at.asc,created_at.desc`));
  if (request.method === "POST" && url.pathname === "/api/tasks") { const body = (await request.json()) as JsonRecord; const rows = await dbRequest<JsonRecord[]>(env, "tasks", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, title: String(body.title || "Untitled task"), notes: String(body.notes || ""), due_at: body.dueAt || null, priority: Number(body.priority || 0), source_message_id: body.sourceMessageId || null }) }); return json(rows[0], 201); }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (request.method === "PATCH" && taskMatch) { const body = (await request.json()) as JsonRecord; const patch: JsonRecord = { updated_at: new Date().toISOString() }; for (const key of ["title", "notes", "due_at", "priority", "completed"]) if (key in body) patch[key] = body[key]; const rows = await dbRequest<JsonRecord[]>(env, `tasks?id=eq.${encodeURIComponent(taskMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }); return json(rows[0] || null); }
  if (request.method === "GET" && url.pathname === "/api/auto-replies") return json(await dbRequest(env, `auto_replies?owner_id=eq.${encodeURIComponent(user.id)}&order=created_at.asc`));
  if (request.method === "POST" && url.pathname === "/api/auto-replies") { const body = (await request.json()) as JsonRecord; const mailboxId = body.mailboxId || mailbox.id; if (!mailboxId) return error("Create a mailbox before configuring automatic replies", 400, "MAILBOX_NOT_ACTIVE"); const rows = await dbRequest<JsonRecord[]>(env, "auto_replies", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ owner_id: user.id, mailbox_id: mailboxId, enabled: body.enabled === true, subject: String(body.subject || "Automatic reply"), body: String(body.body || ""), starts_at: body.startsAt || null, ends_at: body.endsAt || null }) }); return json(rows[0] || null); }
  if (request.method === "GET" && url.pathname === "/api/integrations") return json(await dbRequest(env, `integrations?owner_id=eq.${encodeURIComponent(user.id)}&order=provider.asc`));
  if (request.method === "PATCH" && url.pathname === "/api/integrations") { const body = (await request.json()) as JsonRecord; const provider = String(body.provider || ""); if (!provider) return error("Provider is required"); const rows = await dbRequest<JsonRecord[]>(env, "integrations", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ owner_id: user.id, provider, status: String(body.status || "not_configured"), settings: body.settings || {} }) }); return json(rows[0] || null); }
  if (request.method === "POST" && url.pathname === "/api/drafts") return handleDraft(env, user, (await request.json()) as JsonRecord);
  const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
  if (request.method === "DELETE" && draftMatch) {
    await dbRequest(env, `messages?id=eq.${encodeURIComponent(draftMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&folder=eq.drafts`, { method: "DELETE" });
    return json({ ok: true });
  }
  const retryMatch = url.pathname.match(/^\/api\/send\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    const rows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(retryMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&status=eq.failed&limit=1`);
    if (!rows[0]) return error("Failed message not found", 404, "NOT_FOUND");
    try { await assertMessageCanSend(env, rows[0]); } catch (caught) { if (caught instanceof PlatformError) return platformFail(caught); throw caught; }
    await dbRequest(env, `messages?id=eq.${encodeURIComponent(retryMatch[1])}`, { method: "PATCH", body: JSON.stringify({ status: "queued", send_after: new Date().toISOString(), send_lease_until: null, work_note: "", updated_at: new Date().toISOString() }) });
    if (ctx) ctx.waitUntil(processOutbox(env));
    else await processOutbox(env);
    return json({ ok: true, id: retryMatch[1], status: "queued" });
  }
  if (request.method === "POST" && url.pathname === "/api/attachments") { const form = await request.formData(); const file = form.get("file"); if (!(file instanceof File)) return error("File is required"); if (file.size > 15 * 1024 * 1024) return error("Attachments are limited to 15 MB", 413, "ATTACHMENT_TOO_LARGE"); const bytes = new Uint8Array(await file.arrayBuffer()); const declaredContentType = file.type || "application/octet-stream"; const detectedContentType = detectAttachmentContentType(file.name, declaredContentType, bytes); const safety = buildAttachmentSafety(file.name, declaredContentType, detectedContentType, file.size); if (safety.safetyStatus === "blocked") return error("This attachment type is blocked for safety"); const objectKey = `drafts/${user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`; await putObject(env, objectKey, bytes, detectedContentType); return json({ object_key: objectKey, filename: file.name, content_type: declaredContentType, detected_content_type: detectedContentType, byte_size: file.size, sha256: await sha256Hex(bytes), preview_state: safety.previewState, safety_status: safety.safetyStatus, safety_reasons: safety.safetyReasons, scan_status: "pending" }); }
  if (request.method === "POST" && url.pathname === "/api/send") { try { return await handleSend(env, user.id, (await request.json()) as JsonRecord, ctx); } catch (sendError) { if (sendError instanceof PlatformError) return platformFail(sendError); return error(sendError instanceof Error ? sendError.message : "Send failed", 502, "PROVIDER_TEMPORARY_FAILURE"); } }
  const downloadAllMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/attachments\/download$/);
  if (request.method === "GET" && downloadAllMatch) { const messageRows = await dbRequest<JsonRecord[]>(env, `messages?id=eq.${encodeURIComponent(downloadAllMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`); if (!messageRows[0]) return error("Message not found", 404); const rows = await dbRequest<Array<{ filename: string; object_key: string; byte_size: number }>>(env, `attachments?message_id=eq.${encodeURIComponent(downloadAllMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&order=created_at.asc&limit=10`); if (!rows.length) return error("There are no attachments to download", 404); const totalBytes = rows.reduce((sum, row) => sum + Number(row.byte_size || 0), 0); if (totalBytes > 25 * 1024 * 1024) return error("The download is limited to 25 MB", 413); const entries: Array<{ filename: string; data: Uint8Array }> = []; for (const row of rows) entries.push({ filename: row.filename, data: await readObject(env, row.object_key) }); const archive = buildZip(entries); const archiveName = `${String(messageRows[0].subject || "attachments").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "attachments"}.zip`; return new Response(archive, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${archiveName}"`, "cache-control": "no-store" } }); }
  const previewMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/preview$/);
  if (request.method === "GET" && previewMatch) { const rows = await dbRequest<Array<{ object_key: string; filename: string; content_type: string; detected_content_type?: string | null; byte_size: number; preview_state: string; safety_status: string }>>(env, `attachments?id=eq.${encodeURIComponent(previewMatch[1])}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`); const attachment = rows[0]; if (!attachment) return error("Attachment not found", 404); const contentType = attachment.detected_content_type || attachment.content_type; if (attachment.safety_status === "blocked" || attachment.safety_status === "infected") return error("This attachment is blocked from preview", 409); if (attachment.preview_state !== "ready" || (!contentType.startsWith("image/") && contentType !== "application/pdf") || Number(attachment.byte_size || 0) > 5 * 1024 * 1024) return error("This file is not eligible for safe preview", 415); return json({ url: await signedObjectUrl(env, attachment.object_key), filename: attachment.filename, contentType, previewState: attachment.preview_state }); }
  if (request.method === "GET" && url.pathname.startsWith("/api/attachments/")) { const id = url.pathname.split("/").pop() || ""; const rows = await dbRequest<Array<{ object_key: string }>>(env, `attachments?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(user.id)}&limit=1`); if (!rows[0]) return error("Attachment not found", 404); const signedUrl = await signedObjectUrl(env, rows[0].object_key); return url.searchParams.get("json") === "true" ? json({ url: signedUrl }) : Response.redirect(signedUrl, 302); }
  return error("Not found", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) { try { return protectedHeaders(await api(request, env, ctx)); } catch (requestError) { if (requestError instanceof PlatformError) return platformFail(requestError); return error(requestError instanceof Error ? requestError.message : "Internal server error", 500); } }
    const assetResponse = await env.ASSETS.fetch(request);
    const noStoreAsset = url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest";
    return protectedHeaders(assetResponse, noStoreAsset);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> { await processScheduled(env); },
  async email(message: { from: string; to: string; raw: ReadableStream<Uint8Array>; forward: (address: string) => Promise<void>; setReject: (reason: string) => void }, env: Env, ctx: ExecutionContext): Promise<void> {
    try { const raw = await new Response(message.raw).arrayBuffer(); await ingestRawEmail(env, raw, message.from, message.to, async (address) => message.forward(address), ctx); if (env.OUTLOOK_FORWARD_TO) await message.forward(env.OUTLOOK_FORWARD_TO); }
    catch (ingestError) { message.setReject(ingestError instanceof Error ? ingestError.message.slice(0, 180) : "Inbound processing failed"); }
  },
};

export { buildMailQuery, parseSearchQuery };
