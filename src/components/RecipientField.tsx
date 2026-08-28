import { KeyboardEvent, useState } from "react";
import { X } from "lucide-react";
import { appendRecipient, RecipientChip } from "../lib/recipients";

export function RecipientField({
  label,
  chips,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  chips: RecipientChip[];
  onChange: (chips: RecipientChip[]) => void;
  placeholder: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState("");
  function commit(raw = draft) {
    if (!raw.trim()) return;
    onChange(appendRecipient(chips, raw));
    setDraft("");
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Backspace" && !draft && chips.length) {
      onChange(chips.slice(0, -1));
    }
  }
  return (
    <label className="recipient-field">
      {label}
      <div className={`recipient-chip-box${chips.some((chip) => !chip.valid) ? " has-invalid" : ""}`}>
        {chips.map((chip) => (
          <span className={`recipient-chip${chip.valid ? "" : " invalid"}`} key={chip.value}>
            {chip.value}
            <button
              type="button"
              aria-label={`Remove ${chip.value}`}
              onClick={() => onChange(chips.filter((item) => item.value !== chip.value))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          required={required && chips.length === 0}
          aria-label={label}
          placeholder={chips.length ? "" : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit()}
        />
      </div>
      {chips.some((chip) => !chip.valid) && <small className="field-help">Fix highlighted addresses before sending.</small>}
    </label>
  );
}
