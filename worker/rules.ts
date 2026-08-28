export type JsonRecord = Record<string, unknown>;

export type RuleContext = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  hasAttachment: boolean;
  isRead: boolean;
  isFlagged: boolean;
  isPinned: boolean;
  priority: number;
  folder: string;
};

export type RuleDefinition = {
  id?: string;
  name?: string;
  owner_id?: string;
  conditions?: JsonRecord;
  actions?: JsonRecord;
  enabled?: boolean;
  priority?: number;
};

export type RuleConflict = {
  severity: "error" | "warning";
  message: string;
};

export type RuleEvaluation = {
  matched: boolean;
  reasons: string[];
  plannedActions: JsonRecord;
  conflicts: RuleConflict[];
};

export type WorkState = "none" | "reply_later" | "waiting_on" | "i_owe";

export const RULE_CONDITION_KEYS = [
  "fromContains",
  "toContains",
  "ccContains",
  "subjectContains",
  "bodyContains",
  "hasAttachment",
  "isRead",
  "isFlagged",
  "isPinned",
  "priority",
  "folder",
] as const;

export const RULE_ACTION_KEYS = [
  "folder",
  "customFolderId",
  "markRead",
  "star",
  "pin",
  "flag",
  "priority",
  "label",
  "forwardTo",
  "stopProcessing",
] as const;

const SYSTEM_FOLDERS = new Set(["inbox", "sent", "drafts", "archive", "trash", "spam"]);
const CONDITION_SET = new Set<string>(RULE_CONDITION_KEYS);
const ACTION_SET = new Set<string>(RULE_ACTION_KEYS);

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function textIncludes(value: string | undefined, needle: unknown): boolean {
  return Boolean(String(needle ?? "").trim()) && String(value || "").toLowerCase().includes(String(needle).toLowerCase());
}

function conditionLabel(key: string, value: unknown): string {
  const labels: Record<string, string> = {
    fromContains: "From contains",
    toContains: "To contains",
    ccContains: "Cc contains",
    subjectContains: "Subject contains",
    bodyContains: "Body contains",
    hasAttachment: "Has an attachment",
    isRead: "Read status",
    isFlagged: "Flag status",
    isPinned: "Pin status",
    priority: "Priority",
    folder: "Folder",
  };
  const rendered = typeof value === "boolean" ? (value ? "yes" : "no") : `“${String(value)}”`;
  return `${labels[key] || key} ${rendered}`;
}

function partEvaluation(part: JsonRecord, context: RuleContext, isException = false): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const checks: Array<[string, boolean]> = [];
  if (part.fromContains !== undefined) checks.push(["fromContains", textIncludes(context.from, part.fromContains)]);
  if (part.toContains !== undefined) checks.push(["toContains", context.to.some((value) => textIncludes(value, part.toContains))]);
  if (part.ccContains !== undefined) checks.push(["ccContains", context.cc.some((value) => textIncludes(value, part.ccContains))]);
  if (part.subjectContains !== undefined) checks.push(["subjectContains", textIncludes(context.subject, part.subjectContains)]);
  if (part.bodyContains !== undefined) checks.push(["bodyContains", textIncludes(context.body, part.bodyContains)]);
  if (typeof part.hasAttachment === "boolean") checks.push(["hasAttachment", part.hasAttachment === context.hasAttachment]);
  if (typeof part.isRead === "boolean") checks.push(["isRead", part.isRead === context.isRead]);
  if (typeof part.isFlagged === "boolean") checks.push(["isFlagged", part.isFlagged === context.isFlagged]);
  if (typeof part.isPinned === "boolean") checks.push(["isPinned", part.isPinned === context.isPinned]);
  if (typeof part.priority === "number") checks.push(["priority", part.priority === context.priority]);
  if (typeof part.folder === "string") checks.push(["folder", part.folder === context.folder]);
  for (const [key, matched] of checks) if (matched) reasons.push(conditionLabel(key, part[key]));
  const matches = checks.every(([, matched]) => matched);
  return { matched: checks.length > 0 && matches || !isException && checks.length === 0, reasons };
}

export function ruleContextFromMessage(message: JsonRecord): RuleContext {
  return {
    from: String(message.from_address || ""),
    to: Array.isArray(message.to_addresses) ? message.to_addresses.map(String) : [],
    cc: Array.isArray(message.cc_addresses) ? message.cc_addresses.map(String) : [],
    subject: String(message.subject || ""),
    body: String(message.text_body || ""),
    hasAttachment: message.has_attachment === true,
    isRead: message.is_read === true,
    isFlagged: message.is_flagged === true,
    isPinned: message.is_pinned === true,
    priority: typeof message.priority === "number" ? message.priority : 0,
    folder: String(message.folder || ""),
  };
}

export function evaluateRule(rule: RuleDefinition, context: RuleContext): RuleEvaluation {
  const conditions = objectValue(rule.conditions);
  const exceptions = objectValue(conditions.exceptions);
  const conditionResult = partEvaluation(conditions, context);
  const exceptionResult = partEvaluation(exceptions, context, true);
  const conflicts = ruleConflicts(rule);
  const reasons = conditionResult.reasons.slice();
  if (exceptionResult.matched) reasons.push("Excluded by an exception");
  return {
    matched: conditionResult.matched && !exceptionResult.matched,
    reasons,
    plannedActions: objectValue(rule.actions),
    conflicts,
  };
}

function nonExceptionConditions(conditions: JsonRecord): JsonRecord {
  const next = { ...conditions };
  delete next.exceptions;
  return next;
}

export function validateRuleInput(input: JsonRecord): string[] {
  const errors: string[] = [];
  const name = String(input.name || "").trim();
  if (!name) errors.push("Rule name is required");
  if (name.length > 120) errors.push("Rule name must be 120 characters or fewer");
  if (input.priority !== undefined && (!Number.isFinite(Number(input.priority)) || Number(input.priority) < 0 || Number(input.priority) > 100000)) errors.push("Priority must be between 0 and 100000");
  const conditions = objectValue(input.conditions);
  const exceptions = objectValue(conditions.exceptions);
  if (!Object.keys(nonExceptionConditions(conditions)).length) errors.push("Add at least one condition");
  const checkPart = (part: JsonRecord, label: string) => {
    for (const key of Object.keys(part)) {
      if (key === "exceptions") continue;
      if (!CONDITION_SET.has(key)) { errors.push(`${label} contains unsupported condition “${key}”`); continue; }
      const value = part[key];
      if (["hasAttachment", "isRead", "isFlagged", "isPinned"].includes(key)) {
        if (typeof value !== "boolean") errors.push(`${label} ${key} must be true or false`);
      } else if (["priority"].includes(key)) {
        if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2) errors.push(`${label} priority must be 0, 1, or 2`);
      } else if (typeof value !== "string" || !value.trim() || value.length > 240) {
        errors.push(`${label} ${key} must be a non-empty value of 240 characters or fewer`);
      }
    }
  };
  checkPart(nonExceptionConditions(conditions), "Condition");
  checkPart(exceptions, "Exception");
  const actions = objectValue(input.actions);
  const actionableKeys = Object.keys(actions).filter((key) => key !== "stopProcessing");
  if (!actionableKeys.length) errors.push("Choose at least one action");
  for (const key of Object.keys(actions)) {
    if (!ACTION_SET.has(key)) { errors.push(`Actions contain unsupported key “${key}”`); continue; }
    const value = actions[key];
    if (["markRead", "star", "pin", "flag", "stopProcessing"].includes(key) && typeof value !== "boolean") errors.push(`Action ${key} must be true or false`);
    if (key === "priority" && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2)) errors.push("Action priority must be 0, 1, or 2");
    if (["folder", "customFolderId", "label", "forwardTo"].includes(key) && (typeof value !== "string" || !value.trim() || value.length > 240)) errors.push(`Action ${key} must be a non-empty value of 240 characters or fewer`);
    if (key === "folder" && typeof value === "string" && !SYSTEM_FOLDERS.has(value)) errors.push("Action folder must be a system folder");
    if (key === "forwardTo" && typeof value === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) errors.push("Action forwardTo must be a valid email address");
  }
  return [...new Set(errors)];
}

export function ruleConflicts(rule: RuleDefinition, allRules: RuleDefinition[] = []): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  const conditions = nonExceptionConditions(objectValue(rule.conditions));
  const exceptions = objectValue(objectValue(rule.conditions).exceptions);
  const actions = objectValue(rule.actions);
  if (actions.folder && actions.customFolderId) conflicts.push({ severity: "error", message: "Choose either a system folder or a custom folder, not both." });
  for (const key of Object.keys(conditions)) {
    if (key !== "exceptions" && exceptions[key] !== undefined && String(exceptions[key]) === String(conditions[key])) conflicts.push({ severity: "error", message: `The exception for ${key} cancels this condition.` });
  }
  const others = allRules.filter((candidate) => candidate.id && candidate.id !== rule.id && candidate.enabled !== false);
  if (others.some((candidate) => Number(candidate.priority) === Number(rule.priority))) conflicts.push({ severity: "warning", message: "Another enabled rule has the same priority and may run beside this one." });
  if (rule.name && others.some((candidate) => String(candidate.name || "").trim().toLowerCase() === String(rule.name).trim().toLowerCase())) conflicts.push({ severity: "warning", message: "Another enabled rule has the same name." });
  return conflicts;
}

export function normalizeRuleRecord(input: JsonRecord): JsonRecord {
  const conditions = objectValue(input.conditions);
  const exceptions = objectValue(input.exceptions ?? conditions.exceptions);
  const normalizedConditions: JsonRecord = { ...nonExceptionConditions(conditions) };
  if (Object.keys(exceptions).length) normalizedConditions.exceptions = exceptions;
  const actions = objectValue(input.actions);
  return {
    name: String(input.name || "New rule").trim().slice(0, 120),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    enabled: input.enabled !== false,
    conditions: normalizedConditions,
    actions,
  };
}

export function normalizeWorkState(value: unknown): WorkState | null {
  return value === "none" || value === "reply_later" || value === "waiting_on" || value === "i_owe" ? value : null;
}

export function buildWorkStatePatch(input: JsonRecord, now = new Date()): JsonRecord {
  const state = normalizeWorkState(input.workState);
  if (!state) throw new Error("Choose Reply Later, Waiting On, I Owe, or Clear work");
  if (state === "none") return { work_state: "none", follow_up_at: null, work_note: typeof input.workNote === "string" ? input.workNote.trim().slice(0, 500) : "" };
  const rawFollowUp = input.followUpAt === undefined || input.followUpAt === null || input.followUpAt === ""
    ? new Date(now.getTime() + (state === "waiting_on" ? 3 : 1) * 24 * 60 * 60 * 1000)
    : new Date(String(input.followUpAt));
  if (Number.isNaN(rawFollowUp.getTime())) throw new Error("Follow-up time is invalid");
  return { work_state: state, follow_up_at: rawFollowUp.toISOString(), work_note: typeof input.workNote === "string" ? input.workNote.trim().slice(0, 500) : "" };
}

export function workQueueSummary(rows: JsonRecord[], now = new Date()): { reply_later: number; waiting_on: number; i_owe: number; overdue: number; total: number } {
  const summary = { reply_later: 0, waiting_on: 0, i_owe: 0, overdue: 0, total: 0 };
  for (const row of rows) {
    const state = normalizeWorkState(row.work_state);
    if (!state || state === "none") continue;
    summary[state] += 1;
    summary.total += 1;
    if (row.follow_up_at && new Date(String(row.follow_up_at)).getTime() <= now.getTime()) summary.overdue += 1;
  }
  return summary;
}
