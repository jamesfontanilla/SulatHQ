import test from "node:test";
import assert from "node:assert/strict";
import { documentTitle, PRODUCT_NAME } from "../src/lib/brand.ts";
import { parseAppPath, toAppPath } from "../src/lib/routes.ts";
import {
  appendRecipient,
  hasInvalidRecipient,
  parseRecipientList,
  serializeRecipients,
} from "../src/lib/recipients.ts";
import {
  currentOnboardingStep,
  defaultDnsRecords,
  domainStatusExplanation,
  domainStatusLabel,
  mailboxStatusView,
  mfaStatusLabel,
  onboardingSteps,
} from "../src/lib/domain-model.ts";
import { createDebouncedRunner, draftStatusLabel } from "../src/lib/draft-status.ts";
import { sanitizeEmailHtml } from "../src/lib/email-html.ts";

test("product name is SulatHQ in titles", () => {
  assert.equal(PRODUCT_NAME, "SulatHQ");
  assert.match(documentTitle("Inbox"), /SulatHQ/);
  assert.equal(documentTitle().startsWith("SulatHQ"), true);
});

test("parses product routes for mail, settings, and onboarding", () => {
  assert.deepEqual(parseAppPath("/app/inbox"), { kind: "mail", folder: "inbox" });
  assert.deepEqual(parseAppPath("/login"), { kind: "auth", mode: "signin" });
  assert.deepEqual(parseAppPath("/signup"), { kind: "auth", mode: "signup" });
  assert.deepEqual(parseAppPath("/app/settings/domains"), { kind: "settings", tab: "domains" });
  assert.deepEqual(parseAppPath("/app/settings/mailboxes"), { kind: "settings", tab: "mailboxes" });
  assert.deepEqual(parseAppPath("/app/settings/security"), { kind: "settings", tab: "security" });
  assert.deepEqual(parseAppPath("/app/onboarding/domain"), { kind: "onboarding" });
  assert.deepEqual(parseAppPath("/forgot"), { kind: "auth", mode: "forgot" });
  assert.equal(toAppPath({ kind: "auth", mode: "signup" }), "/signup");
  assert.equal(toAppPath({ kind: "auth", mode: "forgot" }), "/forgot");
  assert.equal(toAppPath({ kind: "mail", folder: "trash" }), "/app/trash");
});

test("recipient chips validate and avoid duplicates", () => {
  const chips = parseRecipientList("Ada <ada@example.com>, ada@example.com; not-an-email");
  assert.equal(chips.length, 2);
  assert.equal(chips[0].valid, true);
  assert.equal(chips[1].valid, false);
  assert.equal(hasInvalidRecipient(chips), true);
  const merged = appendRecipient(chips.slice(0, 1), "ada@example.com");
  assert.equal(merged.length, 1);
  assert.equal(serializeRecipients(merged), "ada@example.com");
});

test("draft autosave debounce runs once and status labels are explicit", async () => {
  assert.equal(draftStatusLabel("new"), "New draft");
  assert.equal(draftStatusLabel("saving"), "Saving");
  assert.equal(draftStatusLabel("save_failed"), "Save failed");
  assert.equal(draftStatusLabel("sending"), "Sending");
  assert.equal(draftStatusLabel("send_failed"), "Send failed");
  let runs = 0;
  const runner = createDebouncedRunner(20);
  runner.schedule(() => { runs += 1; });
  runner.schedule(() => { runs += 1; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs, 1);
});

test("domain and mailbox status copy stays conservative", () => {
  assert.equal(domainStatusLabel("verification_pending"), "Verification pending");
  assert.match(domainStatusExplanation("active"), /SulatHQ/);
  assert.equal(onboardingSteps().length, 6);
  assert.equal(currentOnboardingStep(null, 0), 0);
  const mailbox = mailboxStatusView({
    id: "1",
    address: "hello@example.com",
    display_name: "Hello",
    is_default: true,
    can_send: false,
    can_receive: false,
  });
  assert.equal(mailbox.status, "configuration_required");
  assert.equal(mailbox.domain_name, "example.com");
  assert.equal(defaultDnsRecords("example.com")[0].kind, "TXT");
  assert.equal(mfaStatusLabel(1, false, false), "Two-step verification enabled");
  assert.equal(mfaStatusLabel(0, true, false), "Setup started");
  assert.equal(mfaStatusLabel(0, false, true), "Setup started");
  assert.equal(mfaStatusLabel(0, false, false), "Two-step verification off");
});

test("email HTML sanitizer is used by the reader", () => {
  assert.equal(typeof sanitizeEmailHtml, "function");
  assert.equal(sanitizeEmailHtml.length, 1);
});
