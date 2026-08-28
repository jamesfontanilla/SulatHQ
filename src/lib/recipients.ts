const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export type RecipientChip = {
  value: string;
  valid: boolean;
};

export function normalizeRecipient(value: string) {
  const trimmed = value.trim();
  const angled = trimmed.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : trimmed).trim().toLowerCase();
  const email = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return email ? email[0] : candidate.replace(/^<|>$/g, "");
}

export function isValidRecipient(value: string) {
  return EMAIL_PATTERN.test(normalizeRecipient(value));
}

export function parseRecipientList(value: string): RecipientChip[] {
  const parts = value
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => normalizeRecipient(part));
  const unique: string[] = [];
  for (const part of parts) if (!unique.includes(part)) unique.push(part);
  return unique.map((item) => ({ value: item, valid: isValidRecipient(item) }));
}

export function serializeRecipients(chips: RecipientChip[]) {
  return chips.map((chip) => chip.value).join(", ");
}

export function appendRecipient(chips: RecipientChip[], raw: string) {
  const next = parseRecipientList(raw);
  const merged = [...chips];
  for (const chip of next) {
    if (!merged.some((item) => item.value === chip.value)) merged.push(chip);
  }
  return merged;
}

export function hasInvalidRecipient(chips: RecipientChip[]) {
  return chips.some((chip) => !chip.valid);
}
