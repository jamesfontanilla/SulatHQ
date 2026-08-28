import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudflareMxConfigured,
  fullAddress,
  isValidDomainName,
  isValidLocalPart,
  normalizeDomainName,
  ownershipTxtName,
  ownershipTxtValue,
  parseDomainOrThrow,
  txtValuesMatch,
} from "../worker/platform/domain.ts";
import { PlatformError } from "../worker/platform/errors.ts";
import { isPendingExpired, mfaStatusFromFactors, planMfaStart } from "../worker/platform/mfa.ts";
import {
  buildReplyHeaders,
  canClaimJob,
  inboundIdempotencyKey,
  objectKeyAllowed,
  takeRateLimit,
} from "../worker/platform/jobs.ts";
import { mailboxCanSend, validateRecipients } from "../worker/platform/handlers.ts";
import { brevoTransport } from "../worker/platform/transport.ts";
import { sendingRecordsFromBrevo } from "../worker/platform/brevo-status.ts";

test("normalizes and validates custom domains", () => {
  assert.equal(normalizeDomainName(" Example.COM. "), "example.com");
  assert.equal(isValidDomainName("mail.example.co.uk"), true);
  assert.equal(isValidDomainName("not a domain"), false);
  assert.throws(() => parseDomainOrThrow("nope"), (error: unknown) => error instanceof PlatformError && error.code === "DOMAIN_INVALID");
});

test("matches ownership TXT values using DNS normalization", () => {
  const token = "abc123";
  assert.equal(ownershipTxtName("Example.COM"), "_sulathq-verify.example.com");
  assert.equal(txtValuesMatch([`"sulathq-verify=${token}"`], ownershipTxtValue(token)), true);
  assert.equal(txtValuesMatch(["unrelated"], ownershipTxtValue(token)), false);
});

test("builds mailbox addresses from verified domains", () => {
  assert.equal(isValidLocalPart("hello"), true);
  assert.equal(isValidLocalPart("bad part"), false);
  assert.equal(fullAddress("Support", "Example.com"), "support@example.com");
});

test("treats Cloudflare MX hosts as receiving-ready", () => {
  assert.equal(cloudflareMxConfigured(["route1.mx.cloudflare.net."]), true);
  assert.equal(cloudflareMxConfigured(["aspmx.l.google.com"]), false);
});

test("MFA start reuses a live pending factor and revokes extras on restart", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const pending = { id: "pending-1", status: "unverified", factor_type: "totp", created_at: "2026-08-28T11:50:00.000Z" };
  const reuse = planMfaStart({ verified: [], unverified: [pending], restart: false, now });
  assert.equal(reuse.reusePendingId, "pending-1");
  assert.equal(reuse.enroll, false);
  const restart = planMfaStart({ verified: [], unverified: [pending], restart: true, now });
  assert.deepEqual(restart.revokePendingIds, ["pending-1"]);
  assert.equal(restart.enroll, true);
  assert.equal(mfaStatusFromFactors(1, 0, false), "enabled");
  assert.equal(mfaStatusFromFactors(0, 1, true), "expired");
  assert.equal(isPendingExpired("2026-08-28T11:00:00.000Z", now, 30 * 60 * 1000), true);
});

test("inbound idempotency and object keys stay tenant-scoped", () => {
  assert.equal(inboundIdempotencyKey("box-1", "<ID@example.com>"), "box-1:<id@example.com>");
  assert.equal(objectKeyAllowed("user-1", "org-1", "drafts/user-1/file.pdf"), true);
  assert.equal(objectKeyAllowed("user-1", "org-1", "drafts/other/file.pdf"), false);
});

test("reply headers append In-Reply-To onto References", () => {
  const headers = buildReplyHeaders({ messageIdHeader: "<parent@example.com>", referencesHeader: "<root@example.com> <parent@example.com>" });
  assert.equal(headers.inReplyTo, "<parent@example.com>");
  assert.equal(headers.references, "<root@example.com> <parent@example.com>");
});

test("jobs and send rate limits are retry-safe", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  assert.equal(canClaimJob({ id: "1", status: "queued", locked_at: null, available_at: "2026-08-28T11:00:00.000Z", attempts: 0 }, now), true);
  assert.equal(canClaimJob({ id: "1", status: "succeeded", locked_at: null, available_at: "2026-08-28T11:00:00.000Z", attempts: 1 }, now), false);
  const limited = takeRateLimit({ hitCount: 5, windowStartedAt: "2026-08-28T11:30:00.000Z", now, windowMs: 3600000, maxHits: 5 });
  assert.equal(limited.allowed, false);
});

test("sending is blocked until the mailbox and domain are active", () => {
  const disabled = mailboxCanSend({ can_send: false, status: "disabled" }, null);
  assert.equal(disabled?.code, "MAILBOX_NOT_ACTIVE");
  const pendingDomain = mailboxCanSend({ can_send: true, status: "active" }, { verification_status: "verified", sending_status: "pending_dns" });
  assert.equal(pendingDomain?.code, "DOMAIN_CONFIGURATION_PENDING");
  assert.equal(mailboxCanSend({ can_send: true, status: "active" }, { verification_status: "verified", sending_status: "active" }), null);
  assert.throws(() => validateRecipients(["not-an-email"]), (error: unknown) => error instanceof PlatformError && error.code === "RECIPIENT_INVALID");
});

test("Brevo adapter records provider ids and maps temporary failures", async () => {
  const transport = brevoTransport({
    apiKey: "test-key",
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("/smtp/email")) {
        assert.equal((init?.headers as Record<string, string>)["api-key"], "test-key");
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.sender.email, "hello@example.com");
        assert.equal(payload.headers["In-Reply-To"], "<parent@example.com>");
        return new Response(JSON.stringify({ messageId: "brevo-1" }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    },
  });
  const sent = await transport.send({
    fromAddress: "hello@example.com",
    to: ["friend@elsewhere.com"],
    subject: "Hi",
    text: "Hello",
    inReplyTo: "<parent@example.com>",
  });
  assert.equal(sent.providerMessageId, "brevo-1");
  assert.equal(sent.accepted, true);

  const failing = brevoTransport({
    apiKey: "test-key",
    fetch: async () => new Response("nope", { status: 503 }),
  });
  await assert.rejects(() => failing.send({ fromAddress: "hello@example.com", to: ["a@b.com"], subject: "x", text: "y" }), (error: unknown) => error instanceof PlatformError && error.code === "PROVIDER_TEMPORARY_FAILURE");
  const records = sendingRecordsFromBrevo("example.com", {});
  assert.ok(records.some((record) => record.purpose === "sending_spf"));
});
