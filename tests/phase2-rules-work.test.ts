import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkStatePatch,
  evaluateRule,
  normalizeRuleRecord,
  ruleConflicts,
  ruleContextFromMessage,
  validateRuleInput,
  workQueueSummary,
} from "../worker/rules.ts";

const context = ruleContextFromMessage({
  from_address: "billing@example.com",
  to_addresses: ["james@example.com"],
  subject: "Invoice July",
  text_body: "Your invoice is attached.",
  has_attachment: true,
  is_read: false,
  is_flagged: false,
  is_pinned: false,
  priority: 1,
  folder: "inbox",
});

test("rule evaluator returns match reasons and planned actions", () => {
  const result = evaluateRule({
    name: "Invoices",
    conditions: { fromContains: "billing", hasAttachment: true },
    actions: { folder: "archive", markRead: true },
  }, context);
  assert.equal(result.matched, true);
  assert.equal(result.reasons.length, 2);
  assert.deepEqual(result.plannedActions, { folder: "archive", markRead: true });
});

test("empty exceptions do not block a matching rule, but matching exceptions do", () => {
  const base = { name: "Invoices", conditions: { subjectContains: "invoice" }, actions: { folder: "archive" } };
  assert.equal(evaluateRule(base, context).matched, true);
  assert.equal(evaluateRule({ ...base, conditions: { ...base.conditions, exceptions: {} } }, context).matched, true);
  assert.equal(evaluateRule({ ...base, conditions: { ...base.conditions, exceptions: { fromContains: "billing" } } }, context).matched, false);
});

test("rule validation rejects unsafe or incomplete JSON imports", () => {
  assert.ok(validateRuleInput({ name: "", conditions: {}, actions: {} }).length >= 3);
  assert.ok(validateRuleInput({ name: "Bad", conditions: { unknown: "x" }, actions: { folder: "archive" } }).some((message) => message.includes("unsupported")));
  assert.deepEqual(validateRuleInput(normalizeRuleRecord({ name: "Good", priority: 100, enabled: true, conditions: { subjectContains: "invoice" }, actions: { folder: "archive" } })), []);
});

test("rule conflict checks distinguish fatal overlaps from ordering warnings", () => {
  const rule = { id: "one", name: "Invoices", priority: 100, enabled: true, conditions: { subjectContains: "invoice", exceptions: { subjectContains: "invoice" } }, actions: { folder: "archive", customFolderId: "folder-1" } };
  const conflicts = ruleConflicts(rule, [rule, { id: "two", name: "Other", priority: 100, enabled: true, conditions: { subjectContains: "receipt" }, actions: { folder: "archive" } }]);
  assert.ok(conflicts.some((conflict) => conflict.severity === "error"));
  assert.ok(conflicts.some((conflict) => conflict.severity === "warning"));
});

test("work state transitions normalize due dates and clear cleanly", () => {
  const now = new Date("2026-08-26T00:00:00.000Z");
  const replyLater = buildWorkStatePatch({ workState: "reply_later" }, now);
  assert.equal(replyLater.work_state, "reply_later");
  assert.equal(replyLater.follow_up_at, "2026-08-27T00:00:00.000Z");
  assert.deepEqual(buildWorkStatePatch({ workState: "none" }), { work_state: "none", follow_up_at: null, work_note: "" });
  assert.throws(() => buildWorkStatePatch({ workState: "later" }), /Choose Reply Later/);
});

test("work queue summary counts open and overdue states for a mobile-sized queue", () => {
  const summary = workQueueSummary([
    { work_state: "reply_later", follow_up_at: "2026-08-25T00:00:00.000Z" },
    { work_state: "waiting_on", follow_up_at: "2026-08-27T00:00:00.000Z" },
    { work_state: "i_owe", follow_up_at: null },
    { work_state: "none", follow_up_at: "2026-08-20T00:00:00.000Z" },
  ], new Date("2026-08-26T00:00:00.000Z"));
  assert.deepEqual(summary, { reply_later: 1, waiting_on: 1, i_owe: 1, overdue: 1, total: 3 });
});
