import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttachmentSafety,
  buildSendWarnings,
  buildZip,
  canClaimOutbox,
  canManageOutbox,
  detectAttachmentContentType,
  normalizeUndoSeconds,
  normalizedSendFingerprint,
} from "../worker/phase3.ts";

test("send warnings catch the four high-risk compose mistakes", () => {
  const warnings = buildSendWarnings({
    fromAddress: "james@example.com",
    mailboxAddress: "james@example.com",
    mailboxCanSend: true,
    to: ["friend@other.test"],
    replyTo: "replies@other.test",
    subject: "The report is attached",
    text: "Please see the attached file.",
  });
  assert.deepEqual(warnings.map((warning) => warning.code), ["external_recipient", "reply_to_mismatch", "attachment_omission"]);
  assert.deepEqual(buildSendWarnings({ fromAddress: "other@example.com", mailboxAddress: "james@example.com", mailboxCanSend: true, to: ["friend@example.com"] }).map((warning) => warning.code), ["from_identity"]);
});

test("outbox leases separate due work from future or already-claimed work", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  assert.equal(canClaimOutbox({ status: "queued", send_after: "2026-08-25T23:59:00.000Z" }, now), true);
  assert.equal(canClaimOutbox({ status: "scheduled", send_after: "2026-08-26T00:01:00.000Z" }, now), false);
  assert.equal(canClaimOutbox({ status: "queued", send_after: "2026-08-25T23:59:00.000Z", send_lease_until: "2026-08-26T00:01:00.000Z" }, now), false);
  assert.equal(canManageOutbox({ owner_id: "owner", status: "queued" }, "owner", now), true);
  assert.equal(canManageOutbox({ owner_id: "other", status: "queued" }, "owner", now), false);
});

test("undo settings, MIME detection, and attachment safety stay bounded", () => {
  assert.equal(normalizeUndoSeconds(20), 20);
  assert.equal(normalizeUndoSeconds(15), 0);
  assert.equal(detectAttachmentContentType("report.txt", "text/plain", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), "application/pdf");
  assert.equal(buildAttachmentSafety("photo.png", "image/png", "image/png", 1024).previewState, "ready");
  assert.equal(buildAttachmentSafety("macro.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12", "application/vnd.ms-excel.sheet.macroEnabled.12", 1024).safetyStatus, "suspicious");
});

test("same send payload produces the same duplicate-detection fingerprint", () => {
  const input = { fromAddress: "james@example.com", to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Hello", text: "Body", attachments: [{ filename: "one.txt", object_key: "drafts/owner/one" }] };
  assert.equal(normalizedSendFingerprint(input), normalizedSendFingerprint({ ...input, to: ["b@example.com", "a@example.com"] }));
});

test("bounded ZIP output is a real archive and rejects oversized payloads", () => {
  const archive = buildZip([{ filename: "hello.txt", data: new TextEncoder().encode("hello") }, { filename: "hello.txt", data: new TextEncoder().encode("again") }]);
  assert.deepEqual(Array.from(archive.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.throws(() => buildZip([{ filename: "large.bin", data: new Uint8Array(11) }], 10, 10), /limited/);
});
