import test from "node:test";
import assert from "node:assert/strict";
import { isRecent, isStrongPassword, isValidRecoveryEmail, maskRecoveryEmail, normalizeRecoveryEmail, recoveryCode } from "../worker/security.ts";
import { qrImageSource } from "../src/lib/qr.ts";

test("normalizes and masks recovery email addresses", () => {
  assert.equal(normalizeRecoveryEmail("  Backup@Example.COM "), "backup@example.com");
  assert.equal(maskRecoveryEmail("backup@example.com"), "ba••••@example.com");
  assert.equal(maskRecoveryEmail("a@example.com"), "a••@example.com");
});

test("validates recovery email and strong password policy", () => {
  assert.equal(isValidRecoveryEmail("backup@example.com"), true);
  assert.equal(isValidRecoveryEmail("not-an-email"), false);
  assert.equal(isStrongPassword("long-enough-123"), true);
  assert.equal(isStrongPassword("short1"), false);
});

test("accepts only six digits from a verification code", () => {
  assert.equal(recoveryCode(" 12a3456789 "), "123456");
  assert.equal(recoveryCode("abc"), "");
});

test("recognizes recent rate-limit timestamps", () => {
  const now = Date.parse("2026-08-26T10:00:00.000Z");
  assert.equal(isRecent("2026-08-26T09:59:30.000Z", 60_000, now), true);
  assert.equal(isRecent("2026-08-26T09:58:59.000Z", 60_000, now), false);
});

test("normalizes Supabase QR payloads without double-encoding image sources", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  assert.equal(qrImageSource(svg), `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  assert.equal(qrImageSource("data:image/svg+xml;base64,abc"), "data:image/svg+xml;base64,abc");
  assert.equal(qrImageSource(""), "");
});
