export type SettingsTab =
  | "appearance"
  | "profile"
  | "domains"
  | "mailboxes"
  | "signatures"
  | "security"
  | "sessions"
  | "organize"
  | "contacts"
  | "spam"
  | "automation"
  | "integrations";

export type MailFolder =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "spam"
  | "focused"
  | "other"
  | "search";

export type AppLocation =
  | { kind: "auth"; mode: "signin" | "signup" | "forgot" }
  | { kind: "mail"; folder: MailFolder }
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "onboarding" }
  | { kind: "workspace"; view: "calendar" | "tasks" };

const SETTINGS_TABS: SettingsTab[] = [
  "appearance",
  "profile",
  "domains",
  "mailboxes",
  "signatures",
  "security",
  "sessions",
  "organize",
  "contacts",
  "spam",
  "automation",
  "integrations",
];

const MAIL_FOLDERS: MailFolder[] = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "trash",
  "spam",
  "focused",
  "other",
  "search",
];

export function parseAppPath(pathname: string, hash = ""): AppLocation {
  const fromHash = hash.replace(/^#/, "").trim();
  const raw = (fromHash.startsWith("/") ? fromHash : pathname || "/").split("?")[0];
  const path = raw.replace(/\/+$/, "") || "/";
  if (path === "/login" || path === "/signin") return { kind: "auth", mode: "signin" };
  if (path === "/signup") return { kind: "auth", mode: "signup" };
  if (path === "/forgot" || path === "/reset") return { kind: "auth", mode: "forgot" };
  if (path === "/app/onboarding/domain" || path === "/onboarding/domain") return { kind: "onboarding" };
  if (path === "/app/calendar") return { kind: "workspace", view: "calendar" };
  if (path === "/app/work" || path === "/app/tasks") return { kind: "workspace", view: "tasks" };
  const settings = path.match(/^\/app\/settings(?:\/([^/]+))?$/);
  if (settings) {
    const tab = SETTINGS_TABS.includes(settings[1] as SettingsTab) ? (settings[1] as SettingsTab) : "appearance";
    return { kind: "settings", tab };
  }
  const mail = path.match(/^\/app\/([^/]+)$/);
  if (mail && MAIL_FOLDERS.includes(mail[1] as MailFolder)) return { kind: "mail", folder: mail[1] as MailFolder };
  if (path === "/app" || path === "/") return { kind: "mail", folder: "inbox" };
  return { kind: "mail", folder: "inbox" };
}

export function toAppPath(location: AppLocation) {
  if (location.kind === "auth") {
    if (location.mode === "signup") return "/signup";
    if (location.mode === "forgot") return "/forgot";
    return "/login";
  }
  if (location.kind === "onboarding") return "/app/onboarding/domain";
  if (location.kind === "workspace") return location.view === "calendar" ? "/app/calendar" : "/app/work";
  if (location.kind === "settings") {
    return location.tab === "appearance" ? "/app/settings" : `/app/settings/${location.tab}`;
  }
  return `/app/${location.folder}`;
}

export function replaceAppPath(location: AppLocation) {
  const next = toAppPath(location);
  if (typeof window === "undefined") return next;
  if (/(?:access_token|refresh_token|type=recovery)/.test(window.location.hash)) return next;
  const url = `${window.location.pathname}${window.location.search}#${next}`;
  window.history.replaceState(null, "", url);
  return next;
}
