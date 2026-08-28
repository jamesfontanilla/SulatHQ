import type { Domain, DnsRecordInstruction, Mailbox as ContractMailbox, MfaSetup, Organization, SessionSummary } from "../../src/contracts/platform.ts";
import { PlatformError, platformErrorBody } from "./errors.ts";
import {
  cloudflareMxConfigured,
  generateVerificationToken,
  isValidLocalPart,
  lookupMxDoH,
  lookupTxtDoH,
  normalizeLocalPart,
  ownershipDnsRecord,
  ownershipTxtName,
  ownershipTxtValue,
  parseDomainOrThrow,
  receivingMxRecords,
  txtValuesMatch,
  fullAddress,
} from "./domain.ts";
import { MFA_FRIENDLY_NAME, MFA_PENDING_TTL_MS, planMfaStart, type MfaFactor } from "./mfa.ts";
import { takeRateLimit } from "./jobs.ts";
import { brevoTransport } from "./transport.ts";
import { createClient } from "@supabase/supabase-js";

export type PlatformEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  BREVO_API_KEY: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
};

export type PlatformUser = { id: string; email?: string; accessToken?: string };
export type JsonRecord = Record<string, unknown>;
export type DbRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

type Ctx = {
  env: PlatformEnv;
  user: PlatformUser;
  db: DbRequest;
  fetch: typeof fetch;
  now?: number;
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function fail(error: PlatformError): Response {
  return json(platformErrorBody(error), error.status);
}

async function consumeRateLimit(ctx: Ctx, key: string, windowMs: number, maxHits: number, minIntervalMs = 0): Promise<void> {
  const rows = await ctx.db<Array<{ rate_key: string; window_started_at: string; hit_count: number; last_hit_at: string | null }>>(
    `platform_rate_limits?rate_key=eq.${encodeURIComponent(key)}&limit=1`,
  );
  const current = rows[0];
  const result = takeRateLimit({
    hitCount: current?.hit_count ?? 0,
    windowStartedAt: current?.window_started_at || new Date(ctx.now ?? Date.now()).toISOString(),
    lastHitAt: current?.last_hit_at,
    now: ctx.now,
    windowMs,
    maxHits,
    minIntervalMs,
  });
  await ctx.db("platform_rate_limits", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      rate_key: key,
      window_started_at: result.windowStartedAt,
      hit_count: result.hitCount,
      last_hit_at: new Date(ctx.now ?? Date.now()).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!result.allowed) throw new PlatformError("RATE_LIMITED", "Too many attempts. Try again shortly.", 429);
}

export async function ensureOrganization(ctx: Ctx): Promise<{ organization: Organization; role: Organization["role"] }> {
  const members = await ctx.db<Array<{ organization_id: string; role: Organization["role"]; organizations: { id: string; name: string; slug: string; created_at: string } | { id: string; name: string; slug: string; created_at: string }[] }>>(
    `organization_members?user_id=eq.${encodeURIComponent(ctx.user.id)}&select=organization_id,role,organizations(id,name,slug,created_at)&order=created_at.asc&limit=1`,
  );
  const row = members[0];
  if (row) {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (org) return { organization: { ...org, role: row.role }, role: row.role };
  }
  const slug = `user-${ctx.user.id}`;
  const created = await ctx.db<Array<{ id: string; name: string; slug: string; created_at: string }>>("organizations", {
    method: "POST",
    headers: { Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({ name: ctx.user.email?.split("@")[0] || "Personal workspace", slug }),
  });
  let organization = created[0];
  if (!organization) {
    const existing = await ctx.db<Array<{ id: string; name: string; slug: string; created_at: string }>>(`organizations?slug=eq.${encodeURIComponent(slug)}&limit=1`);
    organization = existing[0];
  }
  if (!organization) throw new PlatformError("VALIDATION_FAILED", "Could not create a workspace", 502);
  await ctx.db("organization_members", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ organization_id: organization.id, user_id: ctx.user.id, role: "owner" }),
  });
  return { organization: { ...organization, role: "owner" }, role: "owner" };
}

function requireManager(role: Organization["role"]): void {
  if (role !== "owner" && role !== "admin") throw new PlatformError("FORBIDDEN", "You need permission to manage this workspace", 403);
}

function domainView(row: JsonRecord, records: DnsRecordInstruction[]): Domain {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    domain_name: String(row.domain_name),
    verification_status: row.verification_status as Domain["verification_status"],
    receiving_status: row.receiving_status as Domain["receiving_status"],
    sending_status: row.sending_status as Domain["sending_status"],
    provider_reference: row.provider_reference ? String(row.provider_reference) : null,
    last_checked_at: row.last_checked_at ? String(row.last_checked_at) : null,
    verified_at: row.verified_at ? String(row.verified_at) : null,
    cloudflare_dns_required: true,
    dns_records: records,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function domainRecords(row: JsonRecord): DnsRecordInstruction[] {
  const domainName = String(row.domain_name);
  const records = [ownershipDnsRecord(domainName, String(row.verification_token))];
  if (row.verification_status === "verified") records.push(...receivingMxRecords(domainName));
  return records;
}

async function loadDomain(ctx: Ctx, organizationId: string, id: string): Promise<JsonRecord> {
  const rows = await ctx.db<JsonRecord[]>(`domains?id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}&limit=1`);
  if (!rows[0]) throw new PlatformError("NOT_FOUND", "Domain not found", 404);
  return rows[0];
}

async function writeAudit(ctx: Ctx, organizationId: string, action: string, resourceType: string, resourceId: string | null, metadata: JsonRecord = {}): Promise<void> {
  await ctx.db("audit_logs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      organization_id: organizationId,
      actor_user_id: ctx.user.id,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      metadata_redacted: metadata,
    }),
  }).catch(() => undefined);
}

async function enqueueJob(ctx: Ctx, organizationId: string, jobType: string, dedupeKey: string, payload: JsonRecord): Promise<void> {
  await ctx.db("platform_jobs", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ organization_id: organizationId, job_type: jobType, dedupe_key: dedupeKey, payload, status: "queued", available_at: new Date().toISOString() }),
  }).catch(() => undefined);
}

export async function handlePlatformApi(request: Request, env: PlatformEnv, user: PlatformUser, db: DbRequest): Promise<Response | null> {
  const url = new URL(request.url);
  const ctx: Ctx = { env, user, db, fetch };
  try {
    if (request.method === "GET" && url.pathname === "/api/me") {
      const { organization } = await ensureOrganization(ctx);
      return json({ user: { id: user.id, email: user.email }, organization });
    }

    if (
      url.pathname === "/api/organizations"
      || url.pathname.startsWith("/api/domains")
      || url.pathname.startsWith("/api/mfa")
      || url.pathname.startsWith("/api/sessions")
      || url.pathname === "/api/events"
    ) {
      return await routePlatform(request, url, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/mailboxes") {
      const body = await request.clone().json().catch(() => ({})) as JsonRecord;
      if (body.domainId || body.domain_id) return await createMailbox(ctx, body);
    }
    const disableMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/disable$/);
    if (request.method === "POST" && disableMatch) return await disableMailbox(ctx, disableMatch[1]);
    const sendDraft = url.pathname.match(/^\/api\/drafts\/([^/]+)\/send$/);
    if (request.method === "POST" && sendDraft) return json({ ok: false, code: "VALIDATION_FAILED", error: "Use /api/send with the draft id" }, 400);
  } catch (caught) {
    if (caught instanceof PlatformError) return fail(caught);
    throw caught;
  }
  return null;
}

async function routePlatform(request: Request, url: URL, ctx: Ctx): Promise<Response> {
  const { organization, role } = await ensureOrganization(ctx);

  if (request.method === "GET" && url.pathname === "/api/organizations") {
    const members = await ctx.db<Array<{ organization_id: string; role: Organization["role"]; organizations: Organization | Organization[] }>>(
      `organization_members?user_id=eq.${encodeURIComponent(ctx.user.id)}&select=organization_id,role,organizations(id,name,slug,created_at)`,
    );
    return json(members.map((row) => {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      return org ? { ...org, role: row.role } : null;
    }).filter(Boolean));
  }

  if (request.method === "GET" && url.pathname === "/api/domains") {
    const rows = await ctx.db<JsonRecord[]>(`domains?organization_id=eq.${encodeURIComponent(organization.id)}&order=created_at.asc`);
    return json(rows.map((row) => domainView(row, domainRecords(row))));
  }

  if (request.method === "POST" && url.pathname === "/api/domains") {
    requireManager(role);
    await consumeRateLimit(ctx, `domain-create:${ctx.user.id}`, 60 * 60 * 1000, 20, 2000);
    const body = await request.json() as JsonRecord;
    const domainName = parseDomainOrThrow(String(body.domainName || body.domain || ""));
    const token = generateVerificationToken();
    const inserted = await ctx.db<JsonRecord[]>("domains", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        organization_id: organization.id,
        domain_name: domainName,
        verification_token: token,
        verification_status: "pending",
        receiving_status: "not_started",
        sending_status: "not_started",
      }),
    }).catch((insertError: unknown) => {
      const message = insertError instanceof Error ? insertError.message : "";
      if (message.includes("23505") || message.toLowerCase().includes("duplicate")) {
        throw new PlatformError("DOMAIN_ALREADY_EXISTS", "That domain is already registered");
      }
      throw insertError;
    });
    const row = inserted[0];
    if (!row) throw new PlatformError("VALIDATION_FAILED", "The domain could not be created", 502);
    await writeAudit(ctx, organization.id, "domain.create", "domain", String(row.id), { domain_name: domainName });
    await enqueueJob(ctx, organization.id, "domain_status_poll", `domain:${row.id}`, { domainId: row.id });
    const view = domainView(row, domainRecords(row));
    return json(view, 201);
  }

  const domainMatch = url.pathname.match(/^\/api\/domains\/([^/]+)$/);
  if (request.method === "GET" && domainMatch) {
    const row = await loadDomain(ctx, organization.id, domainMatch[1]);
    return json(domainView(row, domainRecords(row)));
  }

  const dnsMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/dns$/);
  if (request.method === "GET" && dnsMatch) {
    const row = await loadDomain(ctx, organization.id, dnsMatch[1]);
    return json({ domain: domainView(row, domainRecords(row)), records: domainRecords(row), cloudflare_dns_required: true });
  }

  const verifyMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/verify$/);
  if (request.method === "POST" && verifyMatch) {
    requireManager(role);
    await consumeRateLimit(ctx, `domain-verify:${ctx.user.id}`, 15 * 60 * 1000, 12, 5000);
    const row = await loadDomain(ctx, organization.id, verifyMatch[1]);
    const observed = await lookupTxtDoH(ownershipTxtName(String(row.domain_name)), ctx.fetch);
    const matched = txtValuesMatch(observed, ownershipTxtValue(String(row.verification_token)));
    const now = new Date().toISOString();
    const patch: JsonRecord = {
      last_checked_at: now,
      updated_at: now,
      verification_status: matched ? "verified" : "pending",
      last_error_redacted: matched ? "" : "TXT record does not match yet",
    };
    if (matched && row.verification_status !== "verified") {
      patch.verified_at = now;
      patch.receiving_status = "configuration_required";
    }
    if (!matched && observed.length) patch.verification_status = "failed";
    const updated = await ctx.db<JsonRecord[]>(`domains?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    const next = updated[0] || { ...row, ...patch };
    await writeAudit(ctx, organization.id, "domain.verify", "domain", String(row.id), { matched, observed_count: observed.length });
    if (!matched) {
      return json({ ...domainView(next, domainRecords(next)), code: observed.length ? "DNS_MISMATCH" : "DOMAIN_NOT_VERIFIED" });
    }
    await ctx.db("mailbox_events", {
      method: "POST",
      body: JSON.stringify({
        organization_id: organization.id,
        event_type: "domain.updated",
        preview: { domain_id: row.id, verification_status: "verified" },
      }),
    }).catch(() => undefined);
    return json(domainView(next, domainRecords(next)));
  }

  const receivingMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/receiving$/);
  if (request.method === "POST" && receivingMatch) {
    requireManager(role);
    const row = await loadDomain(ctx, organization.id, receivingMatch[1]);
    if (row.verification_status !== "verified") throw new PlatformError("DOMAIN_NOT_VERIFIED", "Verify domain ownership before configuring receiving");
    const mx = await lookupMxDoH(String(row.domain_name), ctx.fetch);
    const mxOk = cloudflareMxConfigured(mx);
    const now = new Date().toISOString();
    const receiving_status = mxOk ? "active" : "configuration_required";
    const updated = await ctx.db<JsonRecord[]>(`domains?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        receiving_status,
        last_checked_at: now,
        updated_at: now,
        receiving_provider_ref: mxOk ? "cloudflare-mx" : null,
        last_error_redacted: mxOk ? "" : "Add the Cloudflare MX records, then retry",
      }),
    });
    const next = updated[0] || row;
    await writeAudit(ctx, organization.id, "domain.receiving", "domain", String(row.id), { mxOk });
    return json({
      ...domainView(next, [...domainRecords(next), ...receivingMxRecords(String(row.domain_name))]),
      cloudflare_dns_required: true,
      mx_observed: mx,
    });
  }

  const sendingMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/sending$/);
  if (request.method === "POST" && sendingMatch) {
    requireManager(role);
    const row = await loadDomain(ctx, organization.id, sendingMatch[1]);
    if (row.verification_status !== "verified") throw new PlatformError("DOMAIN_NOT_VERIFIED", "Verify domain ownership before configuring sending");
    const transport = brevoTransport({ apiKey: ctx.env.BREVO_API_KEY, fetch: ctx.fetch });
    const status = await transport.verifyDomain({ domainName: String(row.domain_name) });
    const now = new Date().toISOString();
    const sending_status = status.authenticated ? "active" : "pending_dns";
    const updated = await ctx.db<JsonRecord[]>(`domains?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        sending_status,
        sending_provider_ref: status.providerReference,
        provider_reference: status.providerReference,
        last_checked_at: now,
        updated_at: now,
        last_error_redacted: status.error || "",
      }),
    });
    const next = updated[0] || row;
    await writeAudit(ctx, organization.id, "domain.sending", "domain", String(row.id), { authenticated: status.authenticated });
    return json({ ...domainView(next, [...domainRecords(next), ...status.dnsRecords]), sending: status });
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const after = url.searchParams.get("after");
    const mailboxId = url.searchParams.get("mailboxId");
    const filters = [`organization_id=eq.${encodeURIComponent(organization.id)}`];
    if (after) filters.push(`created_at=gt.${encodeURIComponent(after)}`);
    if (mailboxId) filters.push(`mailbox_id=eq.${encodeURIComponent(mailboxId)}`);
    const rows = await ctx.db<JsonRecord[]>(`mailbox_events?${filters.join("&")}&order=created_at.asc&limit=100`);
    return json({ events: rows, polling: { minIntervalMs: 5000, maxIntervalMs: 60000 } });
  }

  if (url.pathname === "/api/mfa" || url.pathname.startsWith("/api/mfa/")) {
    return await handleMfa(request, url, ctx);
  }

  if (url.pathname === "/api/sessions") {
    return await handleSessions(request, url, ctx);
  }

  throw new PlatformError("NOT_FOUND", "Not found", 404);
}

async function createMailbox(ctx: Ctx, body: JsonRecord): Promise<Response> {
  const { organization, role } = await ensureOrganization(ctx);
  requireManager(role);
  const domain = await loadDomain(ctx, organization.id, String(body.domainId || body.domain_id || ""));
  if (domain.verification_status !== "verified") throw new PlatformError("DOMAIN_NOT_VERIFIED", "Verify the domain before creating an address");
  if (domain.receiving_status === "not_started") throw new PlatformError("DOMAIN_CONFIGURATION_PENDING", "Configure receiving before creating an address");
  const localPart = normalizeLocalPart(String(body.localPart || body.local_part || ""));
  if (!isValidLocalPart(localPart)) throw new PlatformError("VALIDATION_FAILED", "Enter a valid local part such as hello");
  const address = fullAddress(localPart, String(domain.domain_name));
  const status = domain.receiving_status === "active" ? "active" : "pending";
  const inserted = await ctx.db<ContractMailbox[]>("mailboxes", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      owner_id: ctx.user.id,
      organization_id: organization.id,
      domain_id: domain.id,
      local_part: localPart,
      address,
      display_name: String(body.displayName || body.display_name || localPart),
      is_default: body.isDefault === true,
      can_send: domain.sending_status === "active",
      can_receive: status === "active",
      status,
    }),
  }).catch((insertError: unknown) => {
    const message = insertError instanceof Error ? insertError.message : "";
    if (message.includes("23505") || message.toLowerCase().includes("duplicate")) {
      throw new PlatformError("VALIDATION_FAILED", "That address already exists");
    }
    throw insertError;
  });
  const mailbox = inserted[0];
  if (!mailbox) throw new PlatformError("VALIDATION_FAILED", "The mailbox could not be created", 502);
  await writeAudit(ctx, organization.id, "mailbox.create", "mailbox", mailbox.id, { address });
  return json(mailbox, 201);
}

async function disableMailbox(ctx: Ctx, mailboxId: string): Promise<Response> {
  const { organization, role } = await ensureOrganization(ctx);
  requireManager(role);
  const updated = await ctx.db<ContractMailbox[]>(`mailboxes?id=eq.${encodeURIComponent(mailboxId)}&organization_id=eq.${encodeURIComponent(organization.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "disabled", can_send: false, can_receive: false, updated_at: new Date().toISOString() }),
  });
  if (!updated[0]) throw new PlatformError("NOT_FOUND", "Mailbox not found", 404);
  await writeAudit(ctx, organization.id, "mailbox.disable", "mailbox", mailboxId, {});
  return json(updated[0]);
}

function authAdmin(env: PlatformEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function asFactors(data: { totp?: MfaFactor[]; phone?: MfaFactor[]; factors?: MfaFactor[] } | null): MfaFactor[] {
  if (!data) return [];
  if (Array.isArray(data.factors)) return data.factors;
  return [...(data.totp || []), ...(data.phone || [])];
}

async function handleMfa(request: Request, url: URL, ctx: Ctx): Promise<Response> {
  await consumeRateLimit(ctx, `mfa:${ctx.user.id}:${request.method}:${url.pathname}`, 15 * 60 * 1000, 20, 1000).catch((error) => {
    if (url.pathname === "/api/mfa" && request.method === "GET") return;
    throw error;
  });
  const client = authAdmin(ctx.env);
  const listed = await client.auth.admin.mfa.listFactors({ userId: ctx.user.id });
  if (listed.error) throw new PlatformError("PROVIDER_TEMPORARY_FAILURE", "Could not load authenticators", 503);
  const factors = asFactors(listed.data as never);
  const verified = factors.filter((factor) => factor.status === "verified");
  const unverified = factors.filter((factor) => factor.status !== "verified" && factor.factor_type === "totp");

  if (request.method === "GET" && url.pathname === "/api/mfa") {
    const pending = unverified[0];
    const status = verified.length ? "enabled" : pending ? "pending_verification" : "not_started";
    const body: MfaSetup = {
      status,
      factor_id: pending?.id || verified[0]?.id || null,
      friendly_name: pending?.friendly_name || verified[0]?.friendly_name || null,
      expires_at: pending ? new Date((ctx.now ?? Date.now()) + MFA_PENDING_TTL_MS).toISOString() : null,
    };
    return json(body);
  }

  if (request.method === "POST" && (url.pathname === "/api/mfa/start" || url.pathname === "/api/mfa/restart")) {
    const restart = url.pathname.endsWith("/restart") || (await request.json().catch(() => ({})) as JsonRecord).restart === true;
    const plan = planMfaStart({ verified, unverified, restart, now: ctx.now });
    if (plan.status === "enabled") {
      return json({ status: "enabled", factor_id: verified[0]?.id || null, friendly_name: verified[0]?.friendly_name || MFA_FRIENDLY_NAME, expires_at: null } satisfies MfaSetup);
    }
    for (const factorId of plan.revokePendingIds) {
      await client.auth.admin.mfa.deleteFactor({ id: factorId, userId: ctx.user.id });
    }
    let factorId = plan.reusePendingId;
    let qrCode = "";
    let secret = "";
    let uri = "";
    if (plan.enroll) {
      const userClient = createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: `Bearer ${ctx.user.accessToken}` } },
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const enrolled = await userClient.auth.mfa.enroll({ factorType: "totp", friendlyName: MFA_FRIENDLY_NAME });
      if (enrolled.error) throw new PlatformError("PROVIDER_TEMPORARY_FAILURE", "Could not start authenticator setup", 503);
      factorId = enrolled.data.id;
      qrCode = enrolled.data.totp.qr_code;
      secret = enrolled.data.totp.secret;
      uri = enrolled.data.totp.uri;
    }
    await ctx.db("mfa_setups", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: ctx.user.id,
        factor_id: factorId,
        friendly_name: MFA_FRIENDLY_NAME,
        status: "pending_verification",
        expires_at: plan.expiresAt,
      }),
    });
    const body: MfaSetup = {
      status: "pending_verification",
      factor_id: factorId,
      friendly_name: MFA_FRIENDLY_NAME,
      qr_code: qrCode || undefined,
      secret: secret || undefined,
      uri: uri || undefined,
      expires_at: plan.expiresAt,
    };
    return json(body, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/mfa/verify") {
    const body = await request.json() as JsonRecord;
    const factorId = String(body.factorId || body.factor_id || "");
    const code = String(body.code || "").replace(/\D/g, "").slice(0, 6);
    if (!factorId || code.length !== 6) throw new PlatformError("MFA_INVALID_CODE", "Enter the six-digit authenticator code");
    const userClient = createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${ctx.user.accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const challenge = await userClient.auth.mfa.challenge({ factorId });
    if (challenge.error) throw new PlatformError("MFA_INVALID_CODE", "Could not start verification");
    const verifiedResult = await userClient.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    if (verifiedResult.error) throw new PlatformError("MFA_INVALID_CODE", "That code was not accepted");
    await ctx.db(`mfa_setups?user_id=eq.${encodeURIComponent(ctx.user.id)}&status=eq.pending_verification`, {
      method: "PATCH",
      body: JSON.stringify({ status: "enabled", verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return json({ status: "enabled", factor_id: factorId, friendly_name: MFA_FRIENDLY_NAME, expires_at: null } satisfies MfaSetup);
  }

  if (request.method === "POST" && url.pathname === "/api/mfa/cancel") {
    const pending = unverified[0];
    if (pending) await client.auth.admin.mfa.deleteFactor({ id: pending.id, userId: ctx.user.id }).catch(() => undefined);
    await ctx.db(`mfa_setups?user_id=eq.${encodeURIComponent(ctx.user.id)}&status=eq.pending_verification`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return json({ status: "cancelled", factor_id: null, friendly_name: null, expires_at: null } satisfies MfaSetup);
  }

  throw new PlatformError("NOT_FOUND", "Not found", 404);
}

async function handleSessions(request: Request, url: URL, ctx: Ctx): Promise<Response> {
  if (request.method === "GET") {
    const sessions: SessionSummary[] = [{
      id: "current",
      current: true,
      user_agent: request.headers.get("user-agent"),
      ip: request.headers.get("cf-connecting-ip"),
      created_at: null,
      updated_at: new Date().toISOString(),
    }];
    return json(sessions);
  }
  const revokeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/revoke$/);
  if (request.method === "POST" && revokeMatch) {
    if (revokeMatch[1] === "others" || revokeMatch[1] === "all") {
      await fetch(`${ctx.env.SUPABASE_URL}/auth/v1/logout?scope=others`, {
        method: "POST",
        headers: { apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ctx.user.accessToken}` },
      }).catch(() => undefined);
      return json({ ok: true });
    }
    throw new PlatformError("NOT_FOUND", "Session not found", 404);
  }
  throw new PlatformError("NOT_FOUND", "Not found", 404);
}

export async function cleanupAbandonedMfa(env: PlatformEnv, db: DbRequest): Promise<number> {
  const cutoff = new Date(Date.now() - MFA_PENDING_TTL_MS).toISOString();
  const rows = await db<Array<{ id: string; user_id: string; factor_id: string | null }>>(
    `mfa_setups?status=eq.pending_verification&created_at=lt.${encodeURIComponent(cutoff)}&select=id,user_id,factor_id&limit=50`,
  );
  const client = authAdmin(env);
  for (const row of rows) {
    if (row.factor_id) await client.auth.admin.mfa.deleteFactor({ id: row.factor_id, userId: row.user_id }).catch(() => undefined);
    await db(`mfa_setups?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "expired", updated_at: new Date().toISOString() }),
    });
  }
  return rows.length;
}

export async function pollDomainJobs(env: PlatformEnv, db: DbRequest, fetchImpl: typeof fetch = fetch): Promise<void> {
  const due = await db<Array<{ id: string; payload: JsonRecord }>>(
    `platform_jobs?job_type=eq.domain_status_poll&status=eq.queued&available_at=lte.${encodeURIComponent(new Date().toISOString())}&limit=20`,
  );
  for (const job of due) {
    const domainId = String(job.payload.domainId || "");
    await db(`platform_jobs?id=eq.${encodeURIComponent(job.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "running", locked_at: new Date().toISOString(), attempts: 1 }),
    });
    try {
      const domains = await db<JsonRecord[]>(`domains?id=eq.${encodeURIComponent(domainId)}&limit=1`);
      const domain = domains[0];
      if (domain) {
        const observed = await lookupTxtDoH(ownershipTxtName(String(domain.domain_name)), fetchImpl);
        const matched = txtValuesMatch(observed, ownershipTxtValue(String(domain.verification_token)));
        if (matched && domain.verification_status !== "verified") {
          await db(`domains?id=eq.${encodeURIComponent(domainId)}`, {
            method: "PATCH",
            body: JSON.stringify({
              verification_status: "verified",
              verified_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              receiving_status: domain.receiving_status === "not_started" ? "configuration_required" : domain.receiving_status,
              updated_at: new Date().toISOString(),
            }),
          });
        } else {
          await db(`domains?id=eq.${encodeURIComponent(domainId)}`, {
            method: "PATCH",
            body: JSON.stringify({ last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
          });
        }
      }
      await db(`platform_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "succeeded", completed_at: new Date().toISOString() }),
      });
    } catch (jobError) {
      await db(`platform_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "queued",
          locked_at: null,
          available_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          last_error_redacted: jobError instanceof Error ? jobError.message.slice(0, 300) : "poll failed",
        }),
      });
    }
  }
}

export function mailboxCanSend(mailbox: { can_send?: boolean; status?: string }, domain?: { sending_status?: string; verification_status?: string } | null): PlatformError | null {
  if (mailbox.status === "disabled" || mailbox.can_send === false) {
    return new PlatformError("MAILBOX_NOT_ACTIVE", "This address is not enabled for sending", 403);
  }
  if (domain && domain.verification_status !== "verified") {
    return new PlatformError("DOMAIN_NOT_VERIFIED", "Verify the domain before sending", 403);
  }
  if (domain && domain.sending_status && domain.sending_status !== "active") {
    return new PlatformError("DOMAIN_CONFIGURATION_PENDING", "Sending is not active for this domain yet", 403);
  }
  return null;
}

export function validateRecipients(addresses: string[]): void {
  if (!addresses.length) throw new PlatformError("RECIPIENT_INVALID", "Add at least one recipient");
  for (const address of addresses) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new PlatformError("RECIPIENT_INVALID", `Invalid recipient: ${address}`);
  }
}
