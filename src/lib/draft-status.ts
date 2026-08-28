export type DraftUiState =
  | "new"
  | "saving"
  | "saved"
  | "save_failed"
  | "sending"
  | "sent"
  | "send_failed";

export function draftStatusLabel(state: DraftUiState, savedAt?: Date | null) {
  if (state === "saving") return "Saving";
  if (state === "saved") {
    return savedAt
      ? `Saved ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Saved";
  }
  if (state === "save_failed") return "Save failed";
  if (state === "sending") return "Sending";
  if (state === "sent") return "Sent";
  if (state === "send_failed") return "Send failed";
  return "New draft";
}

export function createDebouncedRunner(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  return {
    schedule(task: () => void | Promise<void>) {
      if (timer) clearTimeout(timer);
      const current = ++generation;
      timer = setTimeout(() => {
        if (current === generation) void task();
      }, delayMs);
    },
    cancel() {
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
