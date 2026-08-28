import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  Bookmark,
  Briefcase,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Download,
  Eye,
  Flag,
  FolderPlus,
  Forward,
  History,
  Inbox,
  ListTodo,
  LogOut,
  Maximize2,
  Mail,
  Menu,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  PenLine,
  Pin,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  Undo2,
  UploadCloud,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Session } from "@supabase/supabase-js";
import { requireSupabase, supabase } from "./lib/supabase";
import { sanitizeEmailHtml } from "./lib/email-html";
import { qrImageSource } from "./lib/qr";

type SystemFolder = "inbox" | "sent" | "drafts" | "archive" | "trash" | "spam";
type ViewKey = SystemFolder | "focused" | "other" | `custom:${string}`;
  type Message = {
  id: string;
  thread_id: string;
  mailbox_id: string | null;
  direction: "inbound" | "outbound";
  folder: string;
  status: string;
  custom_folder_id?: string | null;
  previous_folder?: string | null;
  from_name?: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses?: string[];
  bcc_addresses?: string[];
  subject: string;
  snippet: string;
  message_id_header?: string | null;
  in_reply_to?: string | null;
  references_header?: string | null;
  reply_to?: string | null;
  text_body?: string;
  html_body?: string | null;
  is_read: boolean;
  is_starred: boolean;
  is_pinned?: boolean;
  is_flagged?: boolean;
  priority?: number;
  has_attachment?: boolean;
  spam_score?: number;
  spam_reasons?: string[];
  trust_score?: number | null;
  trust_reasons?: string[];
  trust_evidence?: Record<string, unknown>;
  auth_results?: Record<string, unknown>;
  auth_spf?: string | null;
  auth_dkim?: string | null;
  auth_dmarc?: string | null;
  auth_arc?: string | null;
  auth_tls?: string | null;
  received_auth_at?: string | null;
  sender_first_seen?: boolean | null;
  known_contact?: boolean | null;
  reply_to_mismatch?: boolean;
  link_count?: number;
  tracking_pixel_count?: number;
  screening_status?: "none" | "review" | "approved" | "blocked" | "rerouted" | string;
  screening_policy_id?: string | null;
  focused_category?: string;
  scheduled_at?: string | null;
  send_after?: string | null;
  cancelled_at?: string | null;
  snoozed_until?: string | null;
  work_state?: "none" | "reply_later" | "waiting_on" | "i_owe" | string | null;
  follow_up_at?: string | null;
  work_note?: string | null;
  received_at?: string;
  sent_at?: string;
  created_at: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    byte_size: number;
    detected_content_type?: string | null;
    preview_state?: "ready" | "not_available" | "pending" | "failed";
    safety_status?: "unknown" | "clean_static" | "suspicious" | "blocked" | "infected";
    safety_reasons?: string[];
  }>;
};
type Contact = {
  id: string;
  display_name: string;
  email: string;
  avatar_url?: string | null;
};
type Mailbox = {
  id: string;
  address: string;
  display_name: string;
  is_default: boolean;
  can_send: boolean;
  can_receive?: boolean;
};
type CustomFolder = { id: string; name: string; color: string; slug: string };
type Label = { id: string; name: string; color: string };
type SavedSearch = {
  id: string;
  name: string;
  query: string;
  color: string;
  sort_order: number;
  result_count?: number | null;
};
type MailPage = {
  items: Message[];
  total: number | null;
  page: number;
  pageSize: number;
  hasMore: boolean;
  normalizedQuery?: string;
};
type SenderPolicy = {
  id: string;
  mailbox_id?: string | null;
  match_type: "address" | "domain";
  match_value: string;
  action: "inbox" | "spam" | "screen" | "archive" | "folder";
  target_folder_id?: string | null;
  enabled: boolean;
};
type ScreeningEvent = { id: string; decision: string; previous_folder?: string | null; created_at: string; restored_at?: string | null };
type TrustData = Message & { screening_history?: ScreeningEvent[] };
type Signature = {
  id: string;
  name: string;
  text_body: string;
  is_default: boolean;
};
type RuleConditionType =
  | "fromContains"
  | "toContains"
  | "ccContains"
  | "subjectContains"
  | "bodyContains"
  | "hasAttachment"
  | "isRead"
  | "isFlagged"
  | "isPinned";
type RuleCondition = { type: RuleConditionType; value: string };
type Rule = {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
};
type RuleLabMatch = {
  id: string;
  subject: string;
  fromAddress: string;
  snippet: string;
  folder: string;
  reasons: string[];
  plannedActions: Record<string, unknown>;
};
type RuleLabResult = {
  runId: string;
  mode: "preview" | "dry_run" | "apply";
  matchedCount: number;
  changedCount: number;
  matches?: RuleLabMatch[];
  impact?: { folders: Record<string, number>; labels: number; markRead: number; forwardCount: number; total: number };
  conflicts?: Array<{ severity: "error" | "warning"; message: string }>;
  failures?: Array<{ id: string; error: string }>;
  undoable?: boolean;
};
type AutoReply = {
  id?: string;
  mailbox_id?: string;
  enabled: boolean;
  subject: string;
  body: string;
  starts_at?: string | null;
  ends_at?: string | null;
};
type AppSettings = {
  theme?: string;
  density?: string;
  reading_pane?: string;
  timezone?: string;
  focused_inbox_enabled?: boolean;
  desktop_notifications?: boolean;
  send_undo_seconds?: 0 | 10 | 20 | 30;
};
type Task = {
  id: string;
  title: string;
  notes: string;
  due_at?: string | null;
  priority: number;
  completed: boolean;
  source_message_id?: string | null;
};
type WorkItem = Message & { overdue?: boolean };
type WorkSummary = {
  reply_later: number;
  waiting_on: number;
  i_owe: number;
  overdue: number;
  total: number;
};
type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  location?: string | null;
  all_day: boolean;
};
type ComposeSeed = {
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  draftId?: string;
};

const folderNames: Record<SystemFolder, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  trash: "Trash",
  spam: "Spam",
};
const folderIcons: Record<SystemFolder, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: PenLine,
  archive: Archive,
  trash: Trash2,
  spam: ShieldAlert,
};

function displayName(address: string) {
  return address.split("@")[0] || address;
}
function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]) : [value.trim()[0] || "?"]).join("").toUpperCase();
}
function avatarGradient(email: string) {
  let hash = 0;
  for (const character of email) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return { background: `linear-gradient(135deg, hsl(${hue} 68% 58%), hsl(${(hue + 42) % 360} 72% 42%))` };
}
function SenderAvatar({ name, email, avatarUrl, large = false }: { name: string; email: string; avatarUrl?: string | null; large?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className={`avatar ${large ? "large-avatar" : "row-avatar"} ${avatarUrl && !imageFailed ? "avatar-image" : ""}`} style={avatarUrl && !imageFailed ? undefined : avatarGradient(email)} aria-label={`${name} profile picture`}>
      {avatarUrl && !imageFailed ? <img src={avatarUrl} alt="" onError={() => setImageFailed(true)} /> : initials(name || email)}
    </div>
  );
}
function contactFor(address: string, contacts: Contact[]) {
  return contacts.find((contact) => contact.email.toLowerCase() === address.toLowerCase());
}
function senderForMessage(message: Message, contacts: Contact[], mailboxes: Mailbox[]) {
  const address = message.direction === "inbound" ? message.from_address : message.to_addresses?.[0] || message.from_address;
  const contact = contactFor(address, contacts);
  const mailbox = mailboxes.find((item) => item.address.toLowerCase() === message.from_address.toLowerCase());
  const name = message.direction === "inbound"
    ? contact?.display_name?.trim() || message.from_name?.trim() || displayName(address)
    : contact?.display_name?.trim() || mailbox?.display_name?.trim() || displayName(address);
  return { name, email: address, avatarUrl: contact?.avatar_url || null };
}
function detailIdentityForMessage(message: Message, contacts: Contact[], mailboxes: Mailbox[]) {
  if (message.direction === "inbound") return senderForMessage(message, contacts, mailboxes);
  const mailbox = mailboxes.find((item) => item.address.toLowerCase() === message.from_address.toLowerCase());
  return {
    name: message.from_name?.trim() || mailbox?.display_name?.trim() || displayName(message.from_address),
    email: message.from_address,
    avatarUrl: null,
  };
}
function formatDate(value?: string) {
  if (!value) return "";
  const d = new Date(value);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function messageStatusLabel(message: Message) {
  if (message.cancelled_at) return "Cancelled";
  if (message.direction === "inbound" && message.status === "queued") return "Receiving";
  if (message.direction === "outbound" && message.status === "queued") return "Sending";
  if (message.status === "received") return "Received";
  if (message.status === "sent") return "Sent";
  if (message.status === "delivered") return "Delivered";
  if (message.status === "failed") return "Failed";
  if (message.status === "bounced") return "Bounced";
  if (message.status === "scheduled") return "Scheduled";
  return message.status;
}
function workStateLabel(state?: string | null) {
  if (state === "reply_later") return "Reply later";
  if (state === "waiting_on") return "Waiting on";
  if (state === "i_owe") return "I owe";
  return "No work state";
}
function workDueLabel(value?: string | null) {
  if (!value) return "No follow-up date";
  const date = new Date(value);
  return date.getTime() <= Date.now() ? `Overdue · ${date.toLocaleString()}` : `Follow up · ${date.toLocaleString()}`;
}
function splitQuotedBody(value: string) {
  const lines = value.split(/\r?\n/);
  const quoteStart = lines.findIndex((line, index) =>
    index > 0 && (/^On .+wrote:\s*$/i.test(line.trim()) || /^>/.test(line.trim())),
  );
  if (quoteStart < 0) return { body: value.trim(), quote: "" };
  return {
    body: lines.slice(0, quoteStart).join("\n").trim(),
    quote: lines.slice(quoteStart).join("\n").trim(),
  };
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;
  constructor(message: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = (await requireSupabase().auth.getSession()).data.session;
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session?.access_token
        ? { authorization: `Bearer ${session.access_token}` }
        : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(payload.error || `Request failed (${response.status})`, response.status, payload);
  return payload as T;
}

async function apiUpload<T>(path: string, file: File): Promise<T> {
  const session = (await requireSupabase().auth.getSession()).data.session;
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(path, {
    method: "POST",
    body: form,
    headers: session?.access_token
      ? { authorization: `Bearer ${session.access_token}` }
      : {},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error || `Upload failed (${response.status})`);
  return payload as T;
}

async function publicApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const client = requireSupabase();
      if (mode === "forgot") {
        const redirectTo = window.location.origin;
        const reset = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (reset.error) throw reset.error;
        await publicApiFetch("/api/auth/recovery-request", {
          method: "POST",
          body: JSON.stringify({ email }),
        }).catch(() => undefined);
        setNotice("If that address is registered, a reset link will arrive shortly. Check your inbox and spam folder.");
      } else {
        const result = mode === "signin"
          ? await client.auth.signInWithPassword({ email, password })
          : await client.auth.signUp({ email, password });
        if (result.error) throw result.error;
        if (mode === "signup" && !result.data.session)
          setNotice("Check your inbox to confirm the account, then sign in here.");
      }
    } catch (authError) {
      setError(
        authError instanceof Error
          ? authError.message
          : "Authentication failed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand-mark">P</div>
        <p className="eyebrow">PRIVATE MAIL / {new Date().getFullYear()}</p>
        <h1>{mode === "forgot" ? "Get back in safely." : "Keep your address close."}</h1>
        <p className="auth-copy">
          {mode === "forgot"
            ? "We’ll send a one-time reset link to your sign-in address or a verified recovery email."
            : "A focused mailbox for your custom domain. Sign in to open messages across desktop and mobile."}
        </p>
        <form onSubmit={submit} className="auth-form">
          <label>
            Email address
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          {mode !== "forgot" && <label>
              Password
              <input
                type="password"
                required
                minLength={mode === "signup" ? 12 : 6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === "signup" ? "12+ characters with a number" : "Your password"}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
              />
            </label>}
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}
          <button className="primary-button" disabled={busy}>
            {busy ? "Working…" : mode === "forgot" ? "Send reset link" : mode === "signin" ? "Open mailbox" : "Create account"}
          </button>
        </form>
        {mode === "signin" && <button className="text-button auth-link" onClick={() => { setMode("forgot"); setError(""); setNotice(""); }}>Forgot your password?</button>}
        <button className="text-button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); }}>
          {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Create one"}
        </button>
        {mode === "forgot" && <button className="text-button" onClick={() => { setMode("signin"); setError(""); setNotice(""); }}>Back to sign in</button>}
      </section>
      <aside className="auth-aside">
        <div className="aside-note">
          <span className="status-dot" /> system ready
        </div>
        <p className="aside-quote">
          “The inbox is the room where your attention either gathers or
          scatters.”
        </p>
        <p className="aside-meta">
          Your messages stay private, organized, and addressed to the names you
          chose.
        </p>
      </aside>
    </main>
  );
}

function PasswordResetScreen({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [completed, setCompleted] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setError("Use at least 12 characters with at least one letter and one number.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await requireSupabase().auth.updateUser({ password });
      if (result.error) throw result.error;
      setNotice("Password updated. Sign in again with your new password.");
      setCompleted(true);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Could not update your password");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand-mark">P</div>
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1>Choose a new password.</h1>
        <p className="auth-copy">This link is temporary. Set a strong password, then sign in again on your other devices.</p>
        <form onSubmit={submit} className="auth-form">
          <label>New password<input type="password" required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="12+ characters with a number" /></label>
          <label>Confirm new password<input type="password" required minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" placeholder="Type it again" /></label>
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}
          {completed ? <button type="button" className="primary-button" onClick={onComplete}>Continue to mailbox</button> : <button className="primary-button" disabled={busy}>{busy ? "Updating…" : "Update password"}</button>}
        </form>
      </section>
      <aside className="auth-aside"><div className="aside-note"><span className="status-dot" /> protected recovery</div><p className="aside-quote">One link. One new password. Back to your mailbox.</p><p className="aside-meta">Parcel never reveals whether an email address has an account.</p></aside>
    </main>
  );
}

type MfaFactor = { id: string; friendly_name?: string; factor_type: "totp" | "phone"; status: "verified" | "unverified" | string };
type RecoveryMethod = { id: string; email_masked: string; verified_at: string | null; pending: boolean; last_sent_at?: string | null };

function MfaChallengeScreen({ onVerified }: { onVerified: () => void }) {
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [factorId, setFactorId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void requireSupabase().auth.mfa.listFactors().then(({ data, error: loadError }) => {
      if (loadError) setError(loadError.message);
      const verified = ([...(data?.totp || []), ...(data?.phone || [])] as MfaFactor[]).filter((item) => item.status === "verified");
      setFactors(verified);
      setFactorId(verified[0]?.id || "");
    });
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!factorId || code.replace(/\D/g, "").length !== 6) { setError("Enter the six-digit code from your authenticator app."); return; }
    setBusy(true);
    setError("");
    try {
      const challenge = await requireSupabase().auth.mfa.challenge({ factorId });
      if (challenge.error) throw challenge.error;
      const verified = await requireSupabase().auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: code.replace(/\D/g, "") });
      if (verified.error) throw verified.error;
      const refreshed = await requireSupabase().auth.refreshSession();
      if (refreshed.error) throw refreshed.error;
      onVerified();
    } catch (mfaError) {
      setError(mfaError instanceof Error ? mfaError.message : "That code was not accepted");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell"><section className="auth-card"><div className="brand-mark">P</div><p className="eyebrow">SECOND STEP</p><h1>Confirm it’s you.</h1><p className="auth-copy">Open your authenticator app and enter the six-digit code to continue to Parcel.</p>{factors.length > 1 && <label>Authenticator<select value={factorId} onChange={(event) => setFactorId(event.target.value)}>{factors.map((factor) => <option key={factor.id} value={factor.id}>{factor.friendly_name || "Authenticator app"}</option>)}</select></label>}<form onSubmit={submit} className="auth-form"><label>Authentication code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label>{error && <div className="form-error">{error}</div>}<button className="primary-button" disabled={busy || !factorId}>{busy ? "Checking…" : "Verify and open mailbox"}</button></form><button className="text-button" onClick={() => void requireSupabase().auth.signOut()}>Sign out</button></section><aside className="auth-aside"><div className="aside-note"><span className="status-dot" /> two-step verification</div><p className="aside-quote">Your password is only the first lock.</p><p className="aside-meta">Keep your authenticator app available. Recovery email is for resetting access, not a replacement for the second factor.</p></aside></main>
  );
}

function Compose({
  mailboxes,
  signatures,
  undoSeconds,
  seed,
  onClose,
  onSent,
}: {
  mailboxes: Mailbox[];
  signatures: Signature[];
  undoSeconds: 0 | 10 | 20 | 30;
  seed?: ComposeSeed;
  onClose: () => void;
  onSent: () => void;
}) {
  const defaultMailbox =
    mailboxes.find((mailbox) => mailbox.is_default) || mailboxes[0];
  const [fromAddress, setFromAddress] = useState(defaultMailbox?.address || "");
  const [to, setTo] = useState(seed?.to || "");
  const [cc, setCc] = useState(seed?.cc || "");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(seed?.subject || "");
  const [text, setText] = useState(seed?.text || "");
  const [scheduledAt, setScheduledAt] = useState("");
  const [draftId, setDraftId] = useState(seed?.draftId || "");
  const [attachments, setAttachments] = useState<
    Array<{
      filename: string;
      object_key: string;
      byte_size: number;
      content_type?: string;
    }>
  >([]);
  const [signatureId, setSignatureId] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [uploading, setUploading] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(Boolean(seed?.cc));
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<Array<{ code: string; title: string; detail: string }>>([]);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveDraft = useCallback(async () => {
    if (!fromAddress || (!to.trim() && !subject.trim() && !text.trim())) return;
    setSaving(true);
    try {
      const saved = await apiFetch<Message>("/api/drafts", {
        method: "POST",
        body: JSON.stringify({
          id: draftId || undefined,
          fromAddress,
          to,
          cc,
          bcc,
          subject,
          text,
        }),
      });
      if (saved?.id) setDraftId(saved.id);
      setLastSavedAt(new Date());
    } catch (draftError) {
      setError(
        draftError instanceof Error
          ? draftError.message
          : "Draft could not be saved",
      );
    } finally {
      setSaving(false);
    }
  }, [bcc, cc, draftId, fromAddress, subject, text, to]);
  useEffect(() => {
    const timer = window.setTimeout(() => void saveDraft(), 3000);
    return () => window.clearTimeout(timer);
  }, [saveDraft]);
  function chooseSignature(id: string) {
    setSignatureId(id);
    const signature = signatures.find((item) => item.id === id);
    if (signature && !text.includes(signature.text_body))
      setText(
        (current) => `${current}${current ? "\n\n" : ""}${signature.text_body}`,
      );
  }
  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setUploading((current) => current + files.length);
    setError("");
    for (const file of files) {
      try {
        const item = await apiUpload<{
          filename: string;
          object_key: string;
          byte_size: number;
          content_type?: string;
        }>("/api/attachments", file);
        setAttachments((current) => [...current, item]);
      } catch (uploadError) {
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : "Attachment upload failed",
        );
      } finally {
        setUploading((current) => Math.max(0, current - 1));
      }
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    await uploadFiles(Array.from(event.target.files || []));
    event.target.value = "";
  }
  function removeAttachment(objectKey: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.object_key !== objectKey),
    );
  }
  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }
  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      setIsDragging(false);
  }
  async function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(false);
    await uploadFiles(Array.from(event.dataTransfer.files));
  }
  function draftStatus() {
    if (saving) return "Saving draft…";
    if (uploading) return `Uploading ${uploading} file${uploading === 1 ? "" : "s"}…`;
    if (lastSavedAt) return `Saved ${lastSavedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    if (draftId) return "Draft saved";
    return "Draft saves automatically";
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/send", {
        method: "POST",
        body: JSON.stringify({
          fromAddress,
          to,
          cc,
          bcc,
          subject,
          text,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          undoSendSeconds: undoSeconds,
          idempotencyKey: idempotencyKeyRef.current,
          warningsAcknowledged: warnings.map((warning) => warning.code),
          threadId: seed?.threadId,
          inReplyTo: seed?.inReplyTo,
          references: seed?.references,
          attachments,
        }),
      });
      onSent();
      onClose();
    } catch (sendError) {
      if (sendError instanceof ApiError && Array.isArray(sendError.payload.warnings)) {
        setWarnings(sendError.payload.warnings as Array<{ code: string; title: string; detail: string }>);
        setError("");
      } else {
        setError(
          sendError instanceof Error
            ? sendError.message
            : "The message could not be sent",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  if (isMinimized) {
    return (
      <div className="compose-minimized" role="dialog" aria-label="Minimized draft">
        <button
          type="button"
          className="compose-minimized-main"
          onClick={() => setIsMinimized(false)}
        >
          <span className="compose-minimized-dot" />
          <span>
            <strong>{subject.trim() || "New message"}</strong>
            <small>{draftStatus()}</small>
          </span>
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close draft"
          title="Close draft"
        >
          <X size={16} />
        </button>
      </div>
    );
  }
  return (
    <div className="compose-overlay" role="presentation">
      <form
        className={`compose-card${isExpanded ? " compose-card-expanded" : ""}`}
        onSubmit={send}
      >
        <div className="compose-head">
          <div>
            <p className="eyebrow">
              {seed?.to ? "REPLY / FORWARD" : "NEW MESSAGE"}
            </p>
            <h2>{seed?.to ? "Continue the thread" : "New message"}</h2>
            <span className="compose-subtitle">
              {seed?.to ? "Your reply stays connected to this conversation." : "A private message from your mailbox."}
            </span>
          </div>
          <div className="compose-head-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => setIsMinimized(true)}
              aria-label="Minimize draft"
              title="Minimize draft"
            >
              <Minimize2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button compose-expand-button"
              onClick={() => setIsExpanded((current) => !current)}
              aria-label={isExpanded ? "Restore compose size" : "Expand compose"}
              title={isExpanded ? "Restore compose size" : "Expand compose"}
            >
              <Maximize2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close draft"
              title="Close draft"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="compose-fields">
          <div className="compose-recipient-row">
            <label className="compose-field-inline">
              From
              <select
                value={fromAddress}
                onChange={(event) => setFromAddress(event.target.value)}
                name="from"
              >
                {mailboxes
                  .filter((mailbox) => mailbox.can_send)
                  .map((mailbox) => (
                    <option key={mailbox.id} value={mailbox.address}>
                      {mailbox.display_name ? `${mailbox.display_name} · ${mailbox.address}` : mailbox.address}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="compose-recipient-toggle"
              onClick={() => setShowCcBcc((current) => !current)}
              aria-expanded={showCcBcc}
            >
              {showCcBcc ? "Hide Cc/Bcc" : "Cc / Bcc"}
            </button>
          </div>
          <label>
            To
            <input
              required
              name="to"
              type="email"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="recipient@example.com…"
              autoComplete="email"
            />
          </label>
          {showCcBcc && (
            <div className="compose-recipient-grid">
              <label>
                Cc
                <input
                  name="cc"
                  value={cc}
                  onChange={(event) => setCc(event.target.value)}
                  placeholder="Optional…"
                  autoComplete="email"
                />
              </label>
              <label>
                Bcc
                <input
                  name="bcc"
                  value={bcc}
                  onChange={(event) => setBcc(event.target.value)}
                  placeholder="Optional…"
                  autoComplete="email"
                />
              </label>
            </div>
          )}
          <label>
            Subject
            <input
              name="subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="What is this about?"
            />
          </label>
          <label className="message-input">
            Message
            <textarea
              required
              name="message"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Start writing…"
              rows={isExpanded ? 13 : 8}
            />
          </label>
        </div>
        <div className="compose-option-row">
          <button
            type="button"
            className="compose-option-button"
            onClick={() => setShowMoreOptions((current) => !current)}
            aria-expanded={showMoreOptions}
          >
            <MoreHorizontal size={15} /> More options
          </button>
          {showMoreOptions && signatures.length > 0 && (
            <label className="compose-signature-select">
              <Tag size={14} aria-hidden="true" />
              <span className="sr-only">Signature</span>
              <select
                value={signatureId}
                onChange={(event) => chooseSignature(event.target.value)}
                aria-label="Add signature"
              >
                <option value="">Add signature</option>
                {signatures.map((signature) => (
                  <option key={signature.id} value={signature.id}>
                    {signature.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showMoreOptions && (
            <label className="schedule-field">
              <Clock3 size={14} aria-hidden="true" />
              <span>Send later</span>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                aria-label="Schedule send"
              />
            </label>
          )}
        </div>
        <div
          className={`attachment-dropzone${isDragging ? " is-dragging" : ""}`}
          role="group"
          aria-label="Attachment drop zone"
          aria-describedby="attachment-help"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(event) => void handleDrop(event)}
        >
          <UploadCloud size={18} aria-hidden="true" />
          <div>
            <strong>{isDragging ? "Drop files to attach" : "Add attachments"}</strong>
            <span id="attachment-help">Drag files here or choose from your device · 15 MB each</span>
          </div>
          <label className="file-button">
            <Paperclip size={15} /> Attach files
            <input ref={fileInputRef} type="file" multiple onChange={upload} />
          </label>
        </div>
        {warnings.length > 0 && (
          <div className="compose-warning" role="alert">
            <div className="compose-warning-head"><AlertTriangle size={15} /><strong>Review before sending</strong></div>
            {warnings.map((warning) => <p key={warning.code}><strong>{warning.title}.</strong> {warning.detail}</p>)}
            <small>Send again to confirm these checks.</small>
          </div>
        )}
        <div className="attachment-strip" aria-live="polite">
          {attachments.map((attachment) => (
            <span className="attachment-chip" key={attachment.object_key}>
              <Paperclip size={13} aria-hidden="true" />
              <span className="attachment-chip-copy">
                <strong>{attachment.filename}</strong>
                <small>{formatBytes(attachment.byte_size)}</small>
              </span>
              <button
                type="button"
                className="attachment-remove"
                onClick={() => removeAttachment(attachment.object_key)}
                aria-label={`Remove ${attachment.filename}`}
                title={`Remove ${attachment.filename}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
        {error && <div className="form-error compose-error">{error}</div>}
        <div className="compose-foot">
          <span className="compose-hint" aria-live="polite">
            <span className={`save-dot${saving ? " is-saving" : ""}`} />
            {draftStatus()}
          </span>
          <button className="primary-button" disabled={busy || uploading > 0}>
            <Send size={15} />{" "}
            {busy ? "Sending…" : scheduledAt ? "Schedule send" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

const ruleConditionLabels: Record<RuleConditionType, string> = {
  fromContains: "Sender contains",
  toContains: "To contains",
  ccContains: "Cc contains",
  subjectContains: "Subject contains",
  bodyContains: "Body contains",
  hasAttachment: "Has attachment",
  isRead: "Read status",
  isFlagged: "Flagged",
  isPinned: "Pinned",
};
const ruleConditionTypes = Object.keys(ruleConditionLabels) as RuleConditionType[];

function ruleConditionsFromRecord(record: Record<string, unknown> | undefined): RuleCondition[] {
  const source = record || {};
  const rows = ruleConditionTypes
    .filter((type) => source[type] !== undefined)
    .map((type) => ({ type, value: String(source[type]) }));
  return rows.length ? rows : [{ type: "fromContains", value: "" }];
}

function ruleConditionRecord(rows: RuleCondition[]): Record<string, unknown> {
  return rows.reduce<Record<string, unknown>>((result, row) => {
    const value = row.value.trim();
    if (!value) return result;
    result[row.type] = ["hasAttachment", "isRead", "isFlagged", "isPinned"].includes(row.type)
      ? value === "true"
      : value;
    return result;
  }, {});
}

function ruleSummary(part: Record<string, unknown>, empty: string): string {
  const labels = ruleConditionTypes
    .filter((type) => part[type] !== undefined)
    .map((type) => `${ruleConditionLabels[type]} ${String(part[type])}`);
  return labels.length ? labels.join(" · ") : empty;
}

function actionMode(actions: Record<string, unknown>, key: string): "ignore" | "true" | "false" {
  return typeof actions[key] === "boolean" ? (actions[key] ? "true" : "false") : "ignore";
}

function SettingsPanel({
  session,
  settings,
  folders,
  labels,
  mailboxes,
  rules,
  senderPolicies,
  onClose,
  onChanged,
  onOpenMessage,
}: {
  session: Session;
  settings: AppSettings;
  folders: CustomFolder[];
  labels: Label[];
  mailboxes: Mailbox[];
  rules: Rule[];
  senderPolicies: SenderPolicy[];
  onClose: () => void;
  onChanged: () => void;
  onOpenMessage: (message: Message) => void;
}) {
  const [tab, setTab] = useState<
    | "appearance"
    | "security"
    | "organize"
    | "contacts"
    | "spam"
    | "automation"
    | "mailboxes"
    | "integrations"
  >("appearance");
  const [folderName, setFolderName] = useState("");
  const [labelName, setLabelName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactAvatarUrl, setContactAvatarUrl] = useState("");
  const [policyType, setPolicyType] = useState<"address" | "domain">("address");
  const [policyValue, setPolicyValue] = useState("");
  const [policyAction, setPolicyAction] = useState<SenderPolicy["action"]>("inbox");
  const [policyMailboxId, setPolicyMailboxId] = useState("");
  const [policyTargetFolderId, setPolicyTargetFolderId] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  const [screeningQueue, setScreeningQueue] = useState<Message[]>([]);
  const [screeningBusy, setScreeningBusy] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleConditions, setRuleConditions] = useState<RuleCondition[]>([
    { type: "fromContains", value: "" },
  ]);
  const [ruleExceptions, setRuleExceptions] = useState<RuleCondition[]>([]);
  const [ruleFolder, setRuleFolder] = useState("none");
  const [ruleCustomFolderId, setRuleCustomFolderId] = useState("");
  const [ruleMarkRead, setRuleMarkRead] = useState<"ignore" | "true" | "false">("ignore");
  const [ruleStar, setRuleStar] = useState<"ignore" | "true" | "false">("ignore");
  const [rulePin, setRulePin] = useState<"ignore" | "true" | "false">("ignore");
  const [ruleFlag, setRuleFlag] = useState<"ignore" | "true" | "false">("ignore");
  const [rulePriorityAction, setRulePriorityAction] = useState("ignore");
  const [ruleLabel, setRuleLabel] = useState("");
  const [ruleForwardTo, setRuleForwardTo] = useState("");
  const [ruleStop, setRuleStop] = useState(true);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [rulePosition, setRulePosition] = useState(100);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [signatureName, setSignatureName] = useState("");
  const [signatureText, setSignatureText] = useState("");
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [mailboxName, setMailboxName] = useState("");
  const [autoReply, setAutoReply] = useState<AutoReply>({
    enabled: false,
    subject: "Automatic reply",
    body: "",
  });
  const [notice, setNotice] = useState("");
  const [securityError, setSecurityError] = useState("");
  const [securityBusy, setSecurityBusy] = useState(false);
  const [recoveryMethods, setRecoveryMethods] = useState<RecoveryMethod[]>([]);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([]);
  const [mfaPendingFactor, setMfaPendingFactor] = useState<MfaFactor | null>(null);
  const [mfaSetup, setMfaSetup] = useState<{ id: string; qrCode: string; secret: string; uri: string } | null>(null);
  const [mfaQrFailed, setMfaQrFailed] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [ruleLab, setRuleLab] = useState<{ rule: Rule; result: RuleLabResult } | null>(null);
  const [ruleLabBusy, setRuleLabBusy] = useState(false);
  const ruleImportRef = useRef<HTMLInputElement>(null);
  async function updateSettings(patch: JsonSettings) {
    await apiFetch("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    onChanged();
  }
  async function createFolder() {
    if (!folderName.trim()) return;
    await apiFetch("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: folderName }),
    });
    setFolderName("");
    setNotice("Folder created");
    onChanged();
  }
  async function createLabel() {
    if (!labelName.trim()) return;
    await apiFetch("/api/labels", {
      method: "POST",
      body: JSON.stringify({ name: labelName }),
    });
    setLabelName("");
    setNotice("Label created");
    onChanged();
  }
  async function createContact() {
    if (!contactEmail.trim()) return;
    await apiFetch("/api/contacts", {
      method: "POST",
      body: JSON.stringify({ email: contactEmail, displayName: contactName, avatarUrl: contactAvatarUrl }),
    });
    setContactEmail("");
    setContactName("");
    setContactAvatarUrl("");
    setNotice("Contact saved");
    onChanged();
  }
  async function createSenderPolicy() {
    if (!policyValue.trim()) {
      setNotice(`Enter a ${policyType === "domain" ? "domain" : "sender address"}`);
      return;
    }
    setPolicyBusy(true);
    try {
      await apiFetch("/api/sender-policies", {
        method: "POST",
        body: JSON.stringify({
          matchType: policyType,
          matchValue: policyValue,
          action: policyAction,
          mailboxId: policyMailboxId || null,
          targetFolderId: policyAction === "folder" ? policyTargetFolderId || null : null,
        }),
      });
      setPolicyValue("");
      setPolicyTargetFolderId("");
      setNotice(policyAction === "inbox" ? "Trusted sender saved" : policyAction === "spam" ? "Blocked sender saved" : "Sender review rule saved");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not save sender policy");
    } finally {
      setPolicyBusy(false);
    }
  }
  async function applyPolicyToExisting(policy: SenderPolicy) {
    if (!window.confirm(`Apply this decision to matching messages already in Parcel? Up to 500 messages will be reviewed.`)) return;
    try {
      const result = await apiFetch<{ matched: number; changed: number; capped?: boolean }>(`/api/sender-policies/${policy.id}/apply-existing`, { method: "POST", body: JSON.stringify({ confirm: true }) });
      setNotice(`${result.changed} existing message${result.changed === 1 ? "" : "s"} updated${result.capped ? " · limited to 500" : ""}`);
      onChanged();
      if (tab === "spam") void loadScreeningQueue();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Existing messages could not be updated");
    }
  }
  async function loadScreeningQueue() {
    try { setScreeningQueue(await apiFetch<Message[]>("/api/screening/queue")); }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : "Screening queue unavailable"); }
  }
  async function decideScreening(message: Message, decision: "approve" | "block" | "reroute") {
    setScreeningBusy(message.id);
    try {
      await apiFetch(`/api/screening/${message.id}/decision`, { method: "POST", body: JSON.stringify({ decision, folder: decision === "reroute" ? "archive" : undefined }) });
      setScreeningQueue((current) => current.filter((item) => item.id !== message.id));
      setNotice(decision === "approve" ? "Message approved to Inbox" : decision === "block" ? "Message moved to Spam" : "Message archived");
      onChanged();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Screening decision failed"); }
    finally { setScreeningBusy(null); }
  }
  async function toggleSenderPolicy(policy: SenderPolicy) {
    try {
      await apiFetch(`/api/sender-policies/${policy.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !policy.enabled }),
      });
      setNotice(policy.enabled ? "Sender policy paused" : "Sender policy enabled");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not update sender policy");
    }
  }
  async function deleteSenderPolicy(policy: SenderPolicy) {
    if (!window.confirm(`Remove this sender decision for ${policy.match_value}?`)) return;
    try {
      await apiFetch(`/api/sender-policies/${policy.id}`, { method: "DELETE" });
      setNotice("Sender policy removed");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not remove sender policy");
    }
  }
  function resetRuleEditor() {
    setEditingRuleId(null);
    setRuleName("");
    setRuleConditions([{ type: "fromContains", value: "" }]);
    setRuleExceptions([]);
    setRuleFolder("none");
    setRuleCustomFolderId("");
    setRuleMarkRead("ignore");
    setRuleStar("ignore");
    setRulePin("ignore");
    setRuleFlag("ignore");
    setRulePriorityAction("ignore");
    setRuleLabel("");
    setRuleForwardTo("");
    setRuleStop(true);
    setRuleEnabled(true);
    setRulePosition(Math.max(100, ...rules.map((rule) => rule.priority + 100)));
  }
  function editRule(rule: Rule) {
    const conditions = rule.conditions || {};
    const exceptions = conditions.exceptions && typeof conditions.exceptions === "object" && !Array.isArray(conditions.exceptions)
      ? conditions.exceptions as Record<string, unknown>
      : {};
    const actions = rule.actions || {};
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleConditions(ruleConditionsFromRecord(conditions));
    setRuleExceptions(ruleConditionsFromRecord(exceptions).filter((row) => row.value));
    setRuleFolder(typeof actions.customFolderId === "string" ? "custom" : typeof actions.folder === "string" ? actions.folder : "none");
    setRuleCustomFolderId(typeof actions.customFolderId === "string" ? actions.customFolderId : "");
    setRuleMarkRead(actionMode(actions, "markRead"));
    setRuleStar(actionMode(actions, "star"));
    setRulePin(actionMode(actions, "pin"));
    setRuleFlag(actionMode(actions, "flag"));
    setRulePriorityAction(typeof actions.priority === "number" ? String(actions.priority) : "ignore");
    setRuleLabel(typeof actions.label === "string" ? actions.label : "");
    setRuleForwardTo(typeof actions.forwardTo === "string" ? actions.forwardTo : "");
    setRuleStop(actions.stopProcessing !== false);
    setRuleEnabled(rule.enabled);
    setRulePosition(rule.priority);
  }
  function updateCondition(setter: (value: RuleCondition[]) => void, rows: RuleCondition[], index: number, patch: Partial<RuleCondition>) {
    setter(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }
  function addCondition(setter: (value: RuleCondition[]) => void, rows: RuleCondition[]) {
    setter([...rows, { type: "subjectContains", value: "" }]);
  }
  function removeCondition(setter: (value: RuleCondition[]) => void, rows: RuleCondition[], index: number) {
    setter(rows.filter((_, rowIndex) => rowIndex !== index));
  }
  async function saveRule() {
    const conditions = ruleConditionRecord(ruleConditions);
    const exceptions = ruleConditionRecord(ruleExceptions);
    const actions: Record<string, unknown> = { stopProcessing: ruleStop };
    if (ruleFolder === "custom" && ruleCustomFolderId) actions.customFolderId = ruleCustomFolderId;
    else if (ruleFolder !== "none") actions.folder = ruleFolder;
    if (ruleMarkRead !== "ignore") actions.markRead = ruleMarkRead === "true";
    if (ruleStar !== "ignore") actions.star = ruleStar === "true";
    if (rulePin !== "ignore") actions.pin = rulePin === "true";
    if (ruleFlag !== "ignore") actions.flag = ruleFlag === "true";
    if (rulePriorityAction !== "ignore") actions.priority = Number(rulePriorityAction);
    if (ruleLabel.trim()) actions.label = ruleLabel.trim();
    if (ruleForwardTo.trim()) actions.forwardTo = ruleForwardTo.trim();
    if (!ruleName.trim()) {
      setNotice("Name the rule before saving");
      return;
    }
    if (!Object.keys(conditions).length) {
      setNotice("Add at least one condition");
      return;
    }
    if (ruleFolder === "custom" && !ruleCustomFolderId) {
      setNotice("Choose a custom folder");
      return;
    }
    if (Object.keys(actions).length === 1) {
      setNotice("Choose at least one action");
      return;
    }
    setRuleBusy(true);
    try {
      await apiFetch(editingRuleId ? `/api/rules/${editingRuleId}` : "/api/rules", {
        method: editingRuleId ? "PATCH" : "POST",
        body: JSON.stringify({
          name: ruleName,
          priority: rulePosition,
          enabled: ruleEnabled,
          conditions,
          exceptions,
          actions,
        }),
      });
      resetRuleEditor();
      setNotice(editingRuleId ? "Rule updated" : "Rule created");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not save rule");
    } finally {
      setRuleBusy(false);
    }
  }
  async function updateRule(rule: Rule, patch: Record<string, unknown>, message: string) {
    try {
      await apiFetch(`/api/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setNotice(message);
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not update rule");
    }
  }
  async function deleteRule(rule: Rule) {
    if (!window.confirm(`Delete the rule “${rule.name}”?`)) return;
    try {
      await apiFetch(`/api/rules/${rule.id}`, { method: "DELETE" });
      if (editingRuleId === rule.id) resetRuleEditor();
      setNotice("Rule deleted");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not delete rule");
    }
  }
  async function reorderRule(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const ids = rules.map((rule) => rule.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await apiFetch("/api/rules/reorder", { method: "POST", body: JSON.stringify({ ids }) });
      setNotice("Rule order updated");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not reorder rules");
    }
  }
  async function runRuleLab(rule: Rule, mode: "preview" | "dry-run") {
    setRuleLabBusy(true);
    try {
      const result = await apiFetch<RuleLabResult>(`/api/rules/${rule.id}/${mode}`, { method: "POST" });
      setRuleLab({ rule, result });
      setNotice(mode === "preview" ? "Preview ready — no messages changed" : "Dry-run ready — review the impact before applying");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not preview this rule");
    } finally {
      setRuleLabBusy(false);
    }
  }
  async function applyRuleLab() {
    if (!ruleLab) return;
    setRuleLabBusy(true);
    try {
      const result = await apiFetch<RuleLabResult>(`/api/rules/${ruleLab.rule.id}/apply`, { method: "POST", body: JSON.stringify({ runId: ruleLab.result.runId }) });
      setRuleLab({ rule: ruleLab.rule, result });
      setNotice(`${result.changedCount} message${result.changedCount === 1 ? "" : "s"} updated. Undo is available for 30 seconds.`);
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not apply this rule");
    } finally {
      setRuleLabBusy(false);
    }
  }
  async function undoRuleLab() {
    if (!ruleLab) return;
    setRuleLabBusy(true);
    try {
      await apiFetch(`/api/rule-runs/${ruleLab.result.runId}/undo`, { method: "POST" });
      setRuleLab(null);
      setNotice("Rule changes undone");
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Rule undo is no longer available");
    } finally {
      setRuleLabBusy(false);
    }
  }
  async function exportRules() {
    try {
      const session = (await requireSupabase().auth.getSession()).data.session;
      const response = await fetch("/api/rules/export", { headers: session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {} });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "parcel-rules.json";
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Rules exported");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Rules could not be exported");
    }
  }
  async function importRules(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      const result = await apiFetch<{ imported: number; failures: Array<{ index: number; error: string }> }>("/api/rules/import", { method: "POST", body: JSON.stringify(payload) });
      setNotice(`${result.imported} rule${result.imported === 1 ? "" : "s"} imported${result.failures.length ? ` · ${result.failures.length} skipped` : ""}`);
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Rules file could not be imported");
    }
  }
  async function createSignature() {
    if (!signatureName.trim()) return;
    await apiFetch("/api/signatures", {
      method: "POST",
      body: JSON.stringify({
        mailboxId: mailboxes[0]?.id,
        name: signatureName,
        text: signatureText,
        isDefault: true,
      }),
    });
    setSignatureName("");
    setSignatureText("");
    setNotice("Signature saved");
    onChanged();
  }
  async function createMailbox() {
    if (!mailboxAddress.trim()) return;
    await apiFetch("/api/mailboxes", {
      method: "POST",
      body: JSON.stringify({
        address: mailboxAddress,
        displayName: mailboxName || mailboxAddress.split("@")[0],
      }),
    });
    setMailboxAddress("");
    setMailboxName("");
    setNotice("Mailbox added");
    onChanged();
  }
  async function updateMailbox(mailbox: Mailbox, patch: JsonSettings) {
    await apiFetch(`/api/mailboxes/${mailbox.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setNotice("Mailbox updated");
    onChanged();
  }
  async function saveAutoReply() {
    await apiFetch("/api/auto-replies", {
      method: "POST",
      body: JSON.stringify({
        mailboxId:
          autoReply.mailbox_id ||
          mailboxes.find((item) => item.is_default)?.id ||
          mailboxes[0]?.id,
        enabled: autoReply.enabled,
        subject: autoReply.subject,
        body: autoReply.body,
        startsAt: autoReply.starts_at || null,
        endsAt: autoReply.ends_at || null,
      }),
    });
    setNotice("Automatic reply saved");
  }
  async function loadSecurity() {
    setSecurityError("");
    try {
      const [methods, factorsResult] = await Promise.all([
        apiFetch<RecoveryMethod[]>("/api/recovery-methods"),
        requireSupabase().auth.mfa.listFactors(),
      ]);
      if (factorsResult.error) throw factorsResult.error;
      setRecoveryMethods(methods);
      const factors = [...(factorsResult.data?.totp || []), ...(factorsResult.data?.phone || [])] as MfaFactor[];
      setMfaFactors(factors.filter((factor) => factor.status === "verified"));
      setMfaPendingFactor(factors.find((factor) => factor.factor_type === "totp" && factor.status === "unverified") || null);
    } catch (loadError) {
      setSecurityError(loadError instanceof Error ? loadError.message : "Security settings unavailable");
    }
  }
  async function sendPrimaryReset() {
    setSecurityBusy(true);
    setSecurityError("");
    try {
      const result = await requireSupabase().auth.resetPasswordForEmail(session.user.email || "", { redirectTo: window.location.origin });
      if (result.error) throw result.error;
      setNotice("A password reset link was sent to your sign-in email");
    } catch (resetError) {
      setSecurityError(resetError instanceof Error ? resetError.message : "Could not send a reset link");
    } finally {
      setSecurityBusy(false);
    }
  }
  async function addRecoveryEmail() {
    if (!recoveryEmail.trim()) return;
    setSecurityBusy(true);
    setSecurityError("");
    try {
      const method = await apiFetch<RecoveryMethod>("/api/recovery-methods", { method: "POST", body: JSON.stringify({ email: recoveryEmail }) });
      setRecoveryEmail("");
      setVerificationId(method.id);
      setVerificationCode("");
      setNotice(`Verification code sent to ${method.email_masked}`);
      await loadSecurity();
    } catch (addError) {
      setSecurityError(addError instanceof Error ? addError.message : "Could not add that recovery email");
    } finally {
      setSecurityBusy(false);
    }
  }
  async function verifyRecoveryEmail() {
    if (!verificationId) return;
    setSecurityBusy(true);
    setSecurityError("");
    try {
      await apiFetch(`/api/recovery-methods/${verificationId}/verify`, { method: "POST", body: JSON.stringify({ code: verificationCode }) });
      setVerificationId(null);
      setVerificationCode("");
      setNotice("Recovery email verified");
      await loadSecurity();
    } catch (verifyError) {
      setSecurityError(verifyError instanceof Error ? verifyError.message : "Could not verify that code");
    } finally {
      setSecurityBusy(false);
    }
  }
  async function removeRecoveryEmail(method: RecoveryMethod) {
    if (!window.confirm(`Remove ${method.email_masked} as a recovery email?`)) return;
    setSecurityBusy(true);
    try {
      await apiFetch(`/api/recovery-methods/${method.id}`, { method: "DELETE" });
      if (verificationId === method.id) setVerificationId(null);
      setNotice("Recovery email removed");
      await loadSecurity();
    } catch (removeError) {
      setSecurityError(removeError instanceof Error ? removeError.message : "Could not remove that recovery email");
    } finally {
      setSecurityBusy(false);
    }
  }
  async function beginMfaSetup() {
    setSecurityBusy(true);
    setSecurityError("");
    try {
      const client = requireSupabase();
      const factorsResult = await client.auth.mfa.listFactors();
      if (factorsResult.error) throw factorsResult.error;
      const pendingFactor = ([...(factorsResult.data?.totp || []), ...(factorsResult.data?.phone || [])] as MfaFactor[]).find((factor) => factor.factor_type === "totp" && factor.status === "unverified") || null;
      if (pendingFactor) {
        const discarded = await client.auth.mfa.unenroll({ factorId: pendingFactor.id });
        if (discarded.error) throw discarded.error;
        setMfaPendingFactor(null);
      }
      let result = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Parcel authenticator" });
      if (result.error && /friendly name.*already exists/i.test(result.error.message)) {
        const retryFactors = await client.auth.mfa.listFactors();
        if (retryFactors.error) throw retryFactors.error;
        const retryPending = ([...(retryFactors.data?.totp || []), ...(retryFactors.data?.phone || [])] as MfaFactor[]).find((factor) => factor.factor_type === "totp" && factor.status === "unverified") || null;
        if (retryPending) {
          const discarded = await client.auth.mfa.unenroll({ factorId: retryPending.id });
          if (discarded.error) throw discarded.error;
          result = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Parcel authenticator" });
        }
      }
      if (result.error) throw result.error;
      setMfaSetup({ id: result.data.id, qrCode: result.data.totp.qr_code, secret: result.data.totp.secret, uri: result.data.totp.uri });
      setMfaPendingFactor(null);
      setMfaQrFailed(false);
      setMfaCode("");
    } catch (enrollError) {
      const message = enrollError instanceof Error ? enrollError.message : "";
      if (/friendly name.*already exists/i.test(message)) {
        let pendingFactor: MfaFactor | null = null;
        try {
          const factorsResult = await requireSupabase().auth.mfa.listFactors();
          if (!factorsResult.error) {
            pendingFactor = ([...(factorsResult.data?.totp || []), ...(factorsResult.data?.phone || [])] as MfaFactor[]).find((factor) => factor.factor_type === "totp" && factor.status === "unverified") || null;
          }
        } catch {
          // Keep the actionable duplicate-name message even if the refresh fails.
        }
        setMfaPendingFactor(pendingFactor);
        setSecurityError(pendingFactor ? "An unfinished authenticator setup already exists. Click Generate a new QR code to replace it." : "An authenticator with this name already exists. Refresh Security & access before starting again.");
      } else {
        setSecurityError(message || "Could not start authenticator setup");
      }
    } finally {
      setSecurityBusy(false);
    }
  }
  async function verifyMfaSetup() {
    if (!mfaSetup) return;
    setSecurityBusy(true);
    setSecurityError("");
    try {
      const challenge = await requireSupabase().auth.mfa.challenge({ factorId: mfaSetup.id });
      if (challenge.error) throw challenge.error;
      const result = await requireSupabase().auth.mfa.verify({ factorId: mfaSetup.id, challengeId: challenge.data.id, code: mfaCode.replace(/\D/g, "") });
      if (result.error) throw result.error;
      const refreshed = await requireSupabase().auth.refreshSession();
      if (refreshed.error) throw refreshed.error;
      setMfaSetup(null);
      setMfaPendingFactor(null);
      setMfaQrFailed(false);
      setMfaCode("");
      setNotice("Two-step verification is now on");
      await loadSecurity();
    } catch (verifyError) {
      setSecurityError(verifyError instanceof Error ? verifyError.message : "That authenticator code was not accepted");
    } finally {
      setSecurityBusy(false);
    }
  }
  async function cancelMfaSetup() {
    if (!mfaSetup) return;
    setSecurityBusy(true);
    setSecurityError("");
    try {
      const result = await requireSupabase().auth.mfa.unenroll({ factorId: mfaSetup.id });
      if (result.error) throw result.error;
      setMfaSetup(null);
      setMfaPendingFactor(null);
      setMfaQrFailed(false);
      setMfaCode("");
      setNotice("Authenticator setup cancelled");
      await loadSecurity();
    } catch (cancelError) {
      setSecurityError(cancelError instanceof Error ? cancelError.message : "Could not cancel authenticator setup");
    } finally {
      setSecurityBusy(false);
    }
  }
  async function removeMfaFactor(factor: MfaFactor) {
    if (!window.confirm(`Remove ${factor.friendly_name || "this authenticator"}? You will need to set up 2FA again to protect the account.`)) return;
    setSecurityBusy(true);
    try {
      const result = await requireSupabase().auth.mfa.unenroll({ factorId: factor.id });
      if (result.error) throw result.error;
      await requireSupabase().auth.refreshSession();
      setNotice("Authenticator removed");
      await loadSecurity();
    } catch (removeError) {
      setSecurityError(removeError instanceof Error ? removeError.message : "Could not remove that authenticator");
    } finally {
      setSecurityBusy(false);
    }
  }
  useEffect(() => {
    if (tab !== "automation") return;
    void apiFetch<AutoReply[]>("/api/auto-replies")
      .then((rows) => {
        if (rows[0]) setAutoReply(rows[0]);
      })
      .catch((loadError) =>
        setNotice(
          loadError instanceof Error
            ? loadError.message
            : "Automatic reply unavailable",
        ),
      );
  }, [tab]);
  useEffect(() => {
    if (tab === "security") void loadSecurity();
    if (tab === "spam") void loadScreeningQueue();
  }, [tab]);
  return (
    <div className="modal-backdrop">
      <section className="settings-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">MAILBOX SETTINGS</p>
            <h2>Settings & organization</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </div>
        <div className="settings-tabs">
          {(
            [
              ["appearance", "Appearance"],
              ["security", "Security & access"],
              ["organize", "Folders & labels"],
              ["contacts", "Contacts"],
              ["spam", "Spam & trust"],
              ["automation", "Rules & signatures"],
              ["mailboxes", "Mailboxes"],
              ["integrations", "Integrations"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "security" && securityError && <div className="settings-alert settings-error" role="alert">{securityError}</div>}
        {tab === "security" && (
          <div className="settings-grid security-settings-grid">
            <div className="setting-card">
              <div className="setting-card-head">
                <div>
                  <h3>Password</h3>
                  <p>Send a one-time password reset link to your sign-in email.</p>
                </div>
                <ShieldAlert size={18} aria-hidden="true" />
              </div>
              <div className="security-email">{session.user.email || "Your sign-in email"}</div>
              <button className="secondary-button" onClick={() => void sendPrimaryReset()} disabled={securityBusy}><Mail size={15} /> Send reset link</button>
            </div>
            <div className="setting-card">
              <div className="setting-card-head">
                <div>
                  <h3>Two-step verification</h3>
                  <p>Use an authenticator app after your password. Parcel will require it at every new sign-in.</p>
                </div>
                <span className={`security-status ${mfaFactors.length ? "enabled" : mfaPendingFactor ? "pending" : ""}`}>{mfaFactors.length ? "On" : mfaPendingFactor ? "Setup paused" : "Off"}</span>
              </div>
              {mfaPendingFactor && !mfaSetup && <div className="mfa-pending"><strong>Previous authenticator setup found</strong><small>You closed setup before verifying the code. Starting again will replace that unfinished factor with a fresh QR code.</small></div>}
              {mfaFactors.length === 0 && !mfaSetup && <button className="secondary-button" onClick={() => void beginMfaSetup()} disabled={securityBusy}><ShieldAlert size={15} /> {securityBusy ? "Generating QR code…" : mfaPendingFactor ? "Generate a new QR code" : "Set up authenticator app"}</button>}
              {mfaFactors.map((factor) => <div className="settings-item security-factor" key={factor.id}><div><strong>{factor.friendly_name || (factor.factor_type === "totp" ? "Authenticator app" : "Phone")}</strong><small>Verified · {factor.factor_type.toUpperCase()}</small></div><button className="text-button danger-text-button" onClick={() => void removeMfaFactor(factor)} disabled={securityBusy}>Remove</button></div>)}
              {mfaSetup && <div className="mfa-enrollment">
                <strong>Scan this QR code</strong>
                <small>Use Google Authenticator, Microsoft Authenticator, 1Password, or another TOTP app. Setup stays off until you enter a valid six-digit code.</small>
                {mfaQrFailed || !qrImageSource(mfaSetup.qrCode) ? <div className="mfa-qr-fallback" role="status">The QR preview could not be rendered. Use the setup key below instead.</div> : <img className="mfa-qr" src={qrImageSource(mfaSetup.qrCode)} onError={() => setMfaQrFailed(true)} alt="QR code for authenticator setup" />}
                <details><summary>Can’t scan? Use the setup key</summary><code>{mfaSetup.secret}</code><small>Or use this authenticator URI:</small><code>{mfaSetup.uri}</code></details>
                <input inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter the six-digit code" aria-label="Authenticator verification code" />
                <div className="security-actions"><button className="primary-button" onClick={() => void verifyMfaSetup()} disabled={securityBusy || mfaCode.length !== 6}>Verify and turn on</button><button className="text-button" onClick={() => void cancelMfaSetup()} disabled={securityBusy}>Cancel</button></div>
              </div>}
            </div>
            <div className="setting-card">
              <div className="setting-card-head">
                <div>
                  <h3>Recovery emails</h3>
                  <p>Add other working addresses for password recovery. Every address must be verified before it can be used.</p>
                </div>
                <span className="rule-count">{recoveryMethods.filter((method) => method.verified_at).length}/5</span>
              </div>
              <div className="inline-form security-recovery-form"><input type="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} placeholder="backup@example.com" aria-label="Recovery email address" /><button className="secondary-button" onClick={() => void addRecoveryEmail()} disabled={securityBusy}><Plus size={15} /> Add</button></div>
              {recoveryMethods.length === 0 && <div className="rule-empty">No recovery email added yet.</div>}
              {recoveryMethods.map((method) => <div className="settings-item security-factor" key={method.id}><div><strong>{method.email_masked}</strong><small>{method.verified_at ? "Verified recovery email" : "Verification needed"}</small></div><div className="security-actions"><button className="text-button danger-text-button" onClick={() => void removeRecoveryEmail(method)} disabled={securityBusy}>Remove</button>{!method.verified_at && <button className="text-button" onClick={() => { setVerificationId(method.id); setVerificationCode(""); }}>Verify</button>}</div></div>)}
              {verificationId && <div className="verification-box"><strong>Enter the code we sent</strong><small>Check the recovery inbox for a six-digit code.</small><input inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" aria-label="Recovery email verification code" /><button className="primary-button" onClick={() => void verifyRecoveryEmail()} disabled={securityBusy || verificationCode.length !== 6}>Verify recovery email</button></div>}
            </div>
            <div className="setting-card">
              <h3>How recovery works</h3>
              <p>Parcel keeps your recovery addresses separate from your sign-in email. A recovery request never reveals whether an account exists, and every reset link is one-time.</p>
              <small className="field-help">Keep at least one recovery address available and store your authenticator app on a device you control. Recovery email can reset access; it cannot bypass an enabled authenticator challenge.</small>
            </div>
          </div>
        )}
        {tab === "appearance" && (
          <div className="settings-grid">
            <div className="setting-card">
              <h3>Interface</h3>
              <p>Shape the desk around how you work.</p>
              <div className="choice-row">
                <button
                  className={settings.theme === "light" ? "selected" : ""}
                  onClick={() => void updateSettings({ theme: "light" })}
                >
                  Light
                </button>
                <button
                  className={settings.theme === "dark" ? "selected" : ""}
                  onClick={() => void updateSettings({ theme: "dark" })}
                >
                  Dark
                </button>
              </div>
              <div className="choice-row">
                <button
                  className={
                    settings.density === "comfortable" ? "selected" : ""
                  }
                  onClick={() =>
                    void updateSettings({ density: "comfortable" })
                  }
                >
                  Comfortable
                </button>
                <button
                  className={settings.density === "compact" ? "selected" : ""}
                  onClick={() => void updateSettings({ density: "compact" })}
                >
                  Compact
                </button>
              </div>
              <label className="settings-select-row">
                <span>Undo Send</span>
                <select
                  value={settings.send_undo_seconds ?? 0}
                  onChange={(event) => void updateSettings({ send_undo_seconds: Number(event.target.value) })}
                >
                  <option value={0}>Off</option>
                  <option value={10}>10 seconds</option>
                  <option value={20}>20 seconds</option>
                  <option value={30}>30 seconds</option>
                </select>
              </label>
              <small className="setting-note">New messages wait this long before the sending queue releases them.</small>
            </div>
            <div className="setting-card">
              <h3>Attention</h3>
              <p>Focused Inbox uses sender history and message signals.</p>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.focused_inbox_enabled !== false}
                  onChange={(event) =>
                    void updateSettings({
                      focused_inbox_enabled: event.target.checked,
                    })
                  }
                />{" "}
                Focused Inbox
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(settings.desktop_notifications)}
                  onChange={(event) =>
                    void updateSettings({
                      desktop_notifications: event.target.checked,
                    })
                  }
                />{" "}
                Desktop notifications
              </label>
            </div>
          </div>
        )}
        {tab === "organize" && (
          <div className="settings-grid">
            <div className="setting-card">
              <h3>Custom folders</h3>
              <div className="inline-form">
                <input
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="Folder name"
                />
                <button
                  className="secondary-button"
                  onClick={() => void createFolder()}
                >
                  <Plus size={15} /> Add
                </button>
              </div>
              {folders.map((folder) => (
                <div className="settings-item" key={folder.id}>
                  <span
                    className="color-dot"
                    style={{ background: folder.color }}
                  />
                  {folder.name}
                </div>
              ))}
            </div>
            <div className="setting-card">
              <h3>Labels</h3>
              <div className="inline-form">
                <input
                  value={labelName}
                  onChange={(event) => setLabelName(event.target.value)}
                  placeholder="Label name"
                />
                <button
                  className="secondary-button"
                  onClick={() => void createLabel()}
                >
                  <Plus size={15} /> Add
                </button>
              </div>
              {labels.map((label) => (
                <div className="settings-item" key={label.id}>
                  <span
                    className="color-dot"
                    style={{ background: label.color }}
                  />
                  {label.name}
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "contacts" && (
          <div className="settings-grid">
            <div className="setting-card">
              <h3>People</h3>
              <p>Save trusted senders so spam scoring learns who matters.</p>
              <input
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                placeholder="Display name"
              />
              <input
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
                placeholder="Email address"
              />
              <input
                type="url"
                value={contactAvatarUrl}
                onChange={(event) => setContactAvatarUrl(event.target.value)}
                placeholder="Profile image URL (optional, https://)"
              />
              <small className="field-help">Names come from the message header. Add a photo here for a saved sender.</small>
              <button
                className="secondary-button"
                onClick={() => void createContact()}
              >
                <Users size={15} /> Save contact
              </button>
            </div>
          </div>
        )}
        {tab === "spam" && (
          <div className="settings-grid spam-settings-grid">
            <div className="setting-card">
              <div className="setting-card-head">
                <div>
                  <h3>Sender decisions</h3>
                  <p>Trust a sender you know or block mail before it reaches the Inbox.</p>
                </div>
                <ShieldAlert size={18} aria-hidden="true" />
              </div>
              <div className="policy-form">
                <select value={policyAction} onChange={(event) => setPolicyAction(event.target.value as typeof policyAction)} aria-label="Sender decision">
                  <option value="inbox">Always trust</option>
                  <option value="spam">Always block</option>
                  <option value="screen">Always review</option>
                  <option value="archive">Archive automatically</option>
                  <option value="folder">Move to folder</option>
                </select>
                <select value={policyType} onChange={(event) => setPolicyType(event.target.value as typeof policyType)} aria-label="Sender match type">
                  <option value="address">This email address</option>
                  <option value="domain">This domain</option>
                </select>
                <input
                  value={policyValue}
                  onChange={(event) => setPolicyValue(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void createSenderPolicy(); }}
                  placeholder={policyType === "domain" ? "example.com" : "sender@example.com"}
                  aria-label={policyType === "domain" ? "Domain" : "Email address"}
                  type={policyType === "domain" ? "text" : "email"}
                />
                <select value={policyMailboxId} onChange={(event) => setPolicyMailboxId(event.target.value)} aria-label="Mailbox scope">
                  <option value="">All mailboxes</option>
                  {mailboxes.map((item) => <option value={item.id} key={item.id}>{item.display_name || item.address}</option>)}
                </select>
                {policyAction === "folder" && <select value={policyTargetFolderId} onChange={(event) => setPolicyTargetFolderId(event.target.value)} aria-label="Destination folder">
                  <option value="">Choose destination folder</option>
                  {folders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                </select>}
                <button className="secondary-button" onClick={() => void createSenderPolicy()} disabled={policyBusy}>
                  {policyAction === "inbox" ? <Check size={15} /> : <ShieldAlert size={15} />}
                  {policyBusy ? "Saving…" : "Save decision"}
                </button>
              </div>
              <small className="field-help">Address rules are stronger than domain rules. Trusted senders still cannot bypass confirmed malware or a dangerous attachment.</small>
            </div>
            <div className="setting-card policy-list-card">
              <div className="setting-card-head">
                <div>
                  <h3>Saved decisions</h3>
                  <p>These choices override the normal spam score for matching mail.</p>
                </div>
                <span className="rule-count">{senderPolicies.length}</span>
              </div>
              {senderPolicies.length === 0 ? (
                <div className="rule-empty">No sender decisions yet.</div>
              ) : senderPolicies.map((policy) => (
                <div className={`settings-item policy-item ${policy.enabled ? "" : "disabled"}`} key={policy.id}>
                  <div className="policy-copy">
                    <strong>{policy.match_value}</strong>
                    <small>{policy.action === "inbox" ? "Trusted" : policy.action === "spam" ? "Blocked" : policy.action === "screen" ? "Review" : policy.action === "archive" ? "Archive" : "Move to folder"} · {policy.match_type}{policy.mailbox_id ? " · mailbox-specific" : " · all mailboxes"}</small>
                  </div>
                  <div className="rule-list-actions">
                    <button className="text-button policy-apply-button" onClick={() => void applyPolicyToExisting(policy)}>Apply to existing</button>
                    <label className="rule-toggle" title={policy.enabled ? "Pause policy" : "Enable policy"}>
                      <input type="checkbox" checked={policy.enabled} onChange={() => void toggleSenderPolicy(policy)} aria-label={`${policy.enabled ? "Disable" : "Enable"} ${policy.match_value}`} />
                      <span />
                    </label>
                    <button className="icon-button compact-icon danger-icon" onClick={() => void deleteSenderPolicy(policy)} aria-label={`Remove ${policy.match_value}`} title="Remove"><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="setting-card screening-queue-card">
              <div className="setting-card-head">
                <div>
                  <h3>Screening queue</h3>
                  <p>Messages needing a decision stay available here without losing their trust evidence.</p>
                </div>
                <span className="rule-count">{screeningQueue.length}</span>
              </div>
              {screeningQueue.length === 0 ? <div className="rule-empty">No messages waiting for review.</div> : screeningQueue.map((message) => (
                <div className="screening-queue-item" key={message.id}>
                  <button className="screening-queue-main" onClick={() => { onClose(); onOpenMessage(message); }}>
                    <strong>{message.subject || "(no subject)"}</strong>
                    <span>{message.from_name || message.from_address}</span>
                    <small>{message.spam_score !== undefined ? `${Math.round((message.spam_score || 0) * 100)}% risk` : "Risk review"} · {message.snippet || "No preview"}</small>
                  </button>
                  <div className="screening-queue-actions">
                    <button className="text-button" disabled={screeningBusy === message.id} onClick={() => void decideScreening(message, "approve")}>Approve</button>
                    <button className="text-button danger-text-button" disabled={screeningBusy === message.id} onClick={() => void decideScreening(message, "block")}>Block</button>
                    <button className="text-button" disabled={screeningBusy === message.id} onClick={() => void decideScreening(message, "reroute")}>Archive</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="setting-card spam-explainer-card">
              <h3>How screening works</h3>
              <p>Parcel combines authentication alignment, sender history, user feedback, links, risky requests, and attachments.</p>
              <div className="screening-legend">
                <span><i className="legend-dot safe" /> Inbox</span>
                <span><i className="legend-dot review" /> Warning</span>
                <span><i className="legend-dot danger" /> Spam</span>
              </div>
              <small className="field-help">One failed authentication check is only a signal. Messages need multiple risk signals before automatic Spam placement.</small>
            </div>
          </div>
        )}
        {tab === "automation" && (
          <div className="settings-grid">
            <div className="setting-card rule-builder-card">
              <div className="setting-card-head">
                <div>
                  <h3>{editingRuleId ? "Edit rule" : "New rule"}</h3>
                  <p>Rules run from top to bottom when new mail arrives.</p>
                </div>
                {editingRuleId && (
                  <button className="text-button" onClick={resetRuleEditor}>
                    Cancel edit
                  </button>
                )}
              </div>
              <input
                value={ruleName}
                onChange={(event) => setRuleName(event.target.value)}
                placeholder="Rule name, e.g. Finance invoices"
                aria-label="Rule name"
              />
              <div className="rule-builder-section">
                <div className="rule-section-label">When a message matches all of these</div>
                {ruleConditions.map((condition, index) => (
                  <div className="rule-condition-row" key={`condition-${index}`}>
                    <select
                      value={condition.type}
                      onChange={(event) => updateCondition(setRuleConditions, ruleConditions, index, { type: event.target.value as RuleConditionType })}
                      aria-label="Condition type"
                    >
                      {ruleConditionTypes.map((type) => <option key={type} value={type}>{ruleConditionLabels[type]}</option>)}
                    </select>
                    {["hasAttachment", "isRead", "isFlagged", "isPinned"].includes(condition.type) ? (
                      <select
                        value={condition.value}
                        onChange={(event) => updateCondition(setRuleConditions, ruleConditions, index, { value: event.target.value })}
                        aria-label="Condition value"
                      >
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : (
                      <input
                        value={condition.value}
                        onChange={(event) => updateCondition(setRuleConditions, ruleConditions, index, { value: event.target.value })}
                        placeholder="Value"
                        aria-label="Condition value"
                      />
                    )}
                    <button
                      className="icon-button compact-icon"
                      onClick={() => removeCondition(setRuleConditions, ruleConditions, index)}
                      disabled={ruleConditions.length === 1}
                      aria-label="Remove condition"
                      title="Remove condition"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button className="text-button" onClick={() => addCondition(setRuleConditions, ruleConditions)}>
                  <Plus size={13} /> Add condition
                </button>
              </div>
              <div className="rule-builder-section">
                <div className="rule-section-label">Except when any of these match</div>
                {ruleExceptions.length === 0 && <small className="rule-muted">No exceptions</small>}
                {ruleExceptions.map((condition, index) => (
                  <div className="rule-condition-row" key={`exception-${index}`}>
                    <select
                      value={condition.type}
                      onChange={(event) => updateCondition(setRuleExceptions, ruleExceptions, index, { type: event.target.value as RuleConditionType })}
                      aria-label="Exception type"
                    >
                      {ruleConditionTypes.map((type) => <option key={type} value={type}>{ruleConditionLabels[type]}</option>)}
                    </select>
                    {["hasAttachment", "isRead", "isFlagged", "isPinned"].includes(condition.type) ? (
                      <select
                        value={condition.value}
                        onChange={(event) => updateCondition(setRuleExceptions, ruleExceptions, index, { value: event.target.value })}
                        aria-label="Exception value"
                      >
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : (
                      <input
                        value={condition.value}
                        onChange={(event) => updateCondition(setRuleExceptions, ruleExceptions, index, { value: event.target.value })}
                        placeholder="Value"
                        aria-label="Exception value"
                      />
                    )}
                    <button
                      className="icon-button compact-icon"
                      onClick={() => removeCondition(setRuleExceptions, ruleExceptions, index)}
                      aria-label="Remove exception"
                      title="Remove exception"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button className="text-button" onClick={() => addCondition(setRuleExceptions, ruleExceptions)}>
                  <Plus size={13} /> Add exception
                </button>
              </div>
              <div className="rule-builder-section">
                <div className="rule-section-label">Do this</div>
                <div className="rule-action-grid">
                  <select value={ruleFolder} onChange={(event) => setRuleFolder(event.target.value)} aria-label="Move message">
                    <option value="none">Do not move</option>
                    <option value="inbox">Move to Inbox</option>
                    <option value="archive">Move to Archive</option>
                    <option value="spam">Move to Spam</option>
                    <option value="trash">Move to Trash</option>
                    <option value="custom">Move to custom folder…</option>
                  </select>
                  {ruleFolder === "custom" && (
                    <select value={ruleCustomFolderId} onChange={(event) => setRuleCustomFolderId(event.target.value)} aria-label="Custom folder">
                      <option value="">Choose folder</option>
                      {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                    </select>
                  )}
                  <select value={ruleMarkRead} onChange={(event) => setRuleMarkRead(event.target.value as typeof ruleMarkRead)} aria-label="Read action">
                    <option value="ignore">Leave read status</option>
                    <option value="true">Mark as read</option>
                    <option value="false">Mark as unread</option>
                  </select>
                  <select value={ruleStar} onChange={(event) => setRuleStar(event.target.value as typeof ruleStar)} aria-label="Star action">
                    <option value="ignore">Leave star</option>
                    <option value="true">Star it</option>
                    <option value="false">Remove star</option>
                  </select>
                  <select value={rulePin} onChange={(event) => setRulePin(event.target.value as typeof rulePin)} aria-label="Pin action">
                    <option value="ignore">Leave pin</option>
                    <option value="true">Pin it</option>
                    <option value="false">Unpin it</option>
                  </select>
                  <select value={ruleFlag} onChange={(event) => setRuleFlag(event.target.value as typeof ruleFlag)} aria-label="Flag action">
                    <option value="ignore">Leave flag</option>
                    <option value="true">Flag it</option>
                    <option value="false">Clear flag</option>
                  </select>
                  <select value={rulePriorityAction} onChange={(event) => setRulePriorityAction(event.target.value)} aria-label="Priority action">
                    <option value="ignore">Leave priority</option>
                    <option value="0">Set low priority</option>
                    <option value="1">Set normal priority</option>
                    <option value="2">Set high priority</option>
                  </select>
                  <input
                    value={ruleLabel}
                    onChange={(event) => setRuleLabel(event.target.value)}
                    placeholder="Add label (optional)"
                    list="rule-labels"
                  />
                  <datalist id="rule-labels">{labels.map((label) => <option key={label.id} value={label.name} />)}</datalist>
                  <input
                    value={ruleForwardTo}
                    onChange={(event) => setRuleForwardTo(event.target.value)}
                    placeholder="Forward to (optional)"
                    type="email"
                  />
                </div>
                <label className="toggle-row">
                  <input type="checkbox" checked={ruleStop} onChange={(event) => setRuleStop(event.target.checked)} /> Stop processing more rules
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={ruleEnabled} onChange={(event) => setRuleEnabled(event.target.checked)} /> Rule is enabled
                </label>
              </div>
              <div className="rule-builder-footer">
                <small className="rule-muted">Rules are evaluated from top to bottom.</small>
                <button className="secondary-button" onClick={() => void saveRule()} disabled={ruleBusy}>
                  <SlidersHorizontal size={15} /> {ruleBusy ? "Saving…" : editingRuleId ? "Save changes" : "Add rule"}
                </button>
              </div>
            </div>
            <div className="setting-card rules-list-card">
              <div className="setting-card-head">
                <div>
                  <h3>Rules in order</h3>
                  <p>Preview a rule first, then apply it with a short undo window.</p>
                </div>
                <div className="rule-list-head-actions">
                  <button className="text-button" onClick={() => void exportRules()} title="Download rules as JSON"><Download size={13} /> Export</button>
                  <button className="text-button" onClick={() => ruleImportRef.current?.click()} title="Import rules from JSON"><Upload size={13} /> Import</button>
                  <input ref={ruleImportRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importRules(event)} />
                  <span className="rule-count">{rules.length}</span>
                </div>
              </div>
              {rules.length === 0 ? (
                <div className="rule-empty">No rules yet. Build your first one on the left.</div>
              ) : rules.map((rule, index) => {
                const exceptions = rule.conditions?.exceptions && typeof rule.conditions.exceptions === "object" && !Array.isArray(rule.conditions.exceptions)
                  ? rule.conditions.exceptions as Record<string, unknown>
                  : {};
                const actionText = rule.actions?.customFolderId
                  ? `Move to ${folders.find((folder) => folder.id === rule.actions.customFolderId)?.name || "custom folder"}`
                  : rule.actions?.folder
                    ? `Move to ${String(rule.actions.folder)}`
                    : "Metadata only";
                return (
                  <article className={`rule-list-item ${rule.enabled ? "" : "disabled"}`} key={rule.id}>
                    <div className="rule-list-copy">
                      <div className="rule-list-title"><span className="rule-order">{index + 1}</span><strong>{rule.name}</strong>{!rule.enabled && <span className="rule-disabled-badge">Disabled</span>}</div>
                      <small>{ruleSummary(rule.conditions, "Every message")} → {actionText}{Object.keys(exceptions).length ? " · with exception" : ""}</small>
                    </div>
                    <div className="rule-list-actions">
                      <label className="rule-toggle" title={rule.enabled ? "Disable rule" : "Enable rule"}>
                        <input type="checkbox" checked={rule.enabled} onChange={(event) => void updateRule(rule, { enabled: event.target.checked }, event.target.checked ? "Rule enabled" : "Rule disabled")} />
                        <span />
                      </label>
                      <button className="icon-button compact-icon" disabled={index === 0} onClick={() => void reorderRule(index, -1)} aria-label="Move rule up" title="Move up"><ArrowUp size={14} /></button>
                      <button className="icon-button compact-icon" disabled={index === rules.length - 1} onClick={() => void reorderRule(index, 1)} aria-label="Move rule down" title="Move down"><ArrowDown size={14} /></button>
                      <button className="icon-button compact-icon" onClick={() => editRule(rule)} aria-label="Edit rule" title="Edit"><Pencil size={14} /></button>
                      <button className="icon-button compact-icon" onClick={() => void runRuleLab(rule, "preview")} aria-label="Preview rule" title="Preview existing mail"><Eye size={14} /></button>
                      <button className="icon-button compact-icon danger-icon" onClick={() => void deleteRule(rule)} aria-label="Delete rule" title="Delete"><Trash2 size={14} /></button>
                    </div>
                  </article>
                );
              })}
            </div>
            {ruleLab && (
              <div className="setting-card rule-lab-panel" aria-live="polite">
                <div className="setting-card-head">
                  <div>
                    <p className="eyebrow">RULE LAB</p>
                    <h3>{ruleLab.rule.name}</h3>
                    <p>{ruleLab.result.mode === "apply" ? `${ruleLab.result.changedCount} changed` : `${ruleLab.result.matchedCount} matching messages`} · {ruleLab.result.mode === "preview" ? "Preview only" : ruleLab.result.mode === "dry_run" ? "Dry-run only" : "Applied"}</p>
                  </div>
                  <button className="icon-button compact-icon" onClick={() => setRuleLab(null)} aria-label="Close rule lab"><X size={14} /></button>
                </div>
                {(ruleLab.result.conflicts || []).length > 0 && (
                  <div className="rule-conflicts">
                    {(ruleLab.result.conflicts || []).map((conflict, index) => (
                      <div className={conflict.severity === "error" ? "rule-conflict error" : "rule-conflict"} key={`${conflict.message}-${index}`}>
                        <AlertTriangle size={14} /> <span>{conflict.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {ruleLab.result.impact && (
                  <div className="rule-impact-grid">
                    <div><strong>{ruleLab.result.impact.total}</strong><span>matches</span></div>
                    <div><strong>{Object.values(ruleLab.result.impact.folders).reduce((total, count) => total + count, 0)}</strong><span>folder moves</span></div>
                    <div><strong>{ruleLab.result.impact.labels}</strong><span>labels</span></div>
                    <div><strong>{ruleLab.result.impact.forwardCount}</strong><span>forwards skipped</span></div>
                  </div>
                )}
                {ruleLab.result.matches && ruleLab.result.matches.length > 0 ? (
                  <div className="rule-match-list">
                    {ruleLab.result.matches.slice(0, 5).map((match) => (
                      <div className="rule-match-item" key={match.id}>
                        <div><strong>{match.subject}</strong><small>{match.fromAddress} · {match.folder}</small></div>
                        <span title={match.reasons.join(" · ")}>{match.reasons[0] || "Matched"}</span>
                      </div>
                    ))}
                    {ruleLab.result.matches.length > 5 && <small className="rule-muted">Showing 5 of {ruleLab.result.matches.length} matches.</small>}
                  </div>
                ) : <div className="rule-empty">No existing messages match this rule.</div>}
                <div className="rule-lab-actions">
                  <button className="secondary-button" onClick={() => void runRuleLab(ruleLab.rule, "dry-run")} disabled={ruleLabBusy}><History size={14} /> Dry-run</button>
                  {ruleLab.result.mode !== "apply" ? <button className="primary-button" onClick={() => { if (window.confirm(`Apply “${ruleLab.rule.name}” to ${ruleLab.result.matchedCount} existing message${ruleLab.result.matchedCount === 1 ? "" : "s"}?`)) void applyRuleLab(); }} disabled={ruleLabBusy || !ruleLab.result.matchedCount || (ruleLab.result.conflicts || []).some((conflict) => conflict.severity === "error")}><Check size={14} /> Apply changes</button> : ruleLab.result.undoable ? <button className="secondary-button" onClick={() => void undoRuleLab()} disabled={ruleLabBusy}><RotateCcw size={14} /> Undo changes</button> : null}
                </div>
              </div>
            )}
            <div className="setting-card">
              <h3>Signatures</h3>
              <input
                value={signatureName}
                onChange={(event) => setSignatureName(event.target.value)}
                placeholder="Signature name"
              />
              <textarea
                value={signatureText}
                onChange={(event) => setSignatureText(event.target.value)}
                placeholder="Regards, James"
                rows={4}
              />
              <button
                className="secondary-button"
                onClick={() => void createSignature()}
              >
                <PenLine size={15} /> Save signature
              </button>
            </div>
            <div className="setting-card">
              <h3>Automatic replies</h3>
              <p>
                Send one rate-limited vacation response for the selected
                mailbox.
              </p>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={autoReply.enabled}
                  onChange={(event) =>
                    setAutoReply((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />{" "}
                Enabled
              </label>
              <input
                value={autoReply.subject}
                onChange={(event) =>
                  setAutoReply((current) => ({
                    ...current,
                    subject: event.target.value,
                  }))
                }
                placeholder="Automatic reply subject"
              />
              <textarea
                value={autoReply.body}
                onChange={(event) =>
                  setAutoReply((current) => ({
                    ...current,
                    body: event.target.value,
                  }))
                }
                placeholder="I am away and will reply soon."
                rows={4}
              />
              <button
                className="secondary-button"
                onClick={() => void saveAutoReply()}
              >
                <Bell size={15} /> Save reply
              </button>
            </div>
          </div>
        )}
        {tab === "mailboxes" && (
          <div className="settings-grid">
            <div className="setting-card">
              <h3>Add an address</h3>
              <p>
                Each address can send through Brevo and receive through
                Cloudflare routing.
              </p>
              <input
                value={mailboxName}
                onChange={(event) => setMailboxName(event.target.value)}
                placeholder="Display name"
              />
              <input
                type="email"
                value={mailboxAddress}
                onChange={(event) => setMailboxAddress(event.target.value)}
                placeholder="name@your-domain.com"
              />
              <button
                className="secondary-button"
                onClick={() => void createMailbox()}
              >
                <Plus size={15} /> Add mailbox
              </button>
            </div>
            <div className="setting-card">
              <h3>Connected addresses</h3>
              {mailboxes.map((item) => (
                <div className="settings-item mailbox-setting" key={item.id}>
                  <div>
                    <strong>{item.address}</strong>
                    <small>
                      {item.display_name}
                      {item.is_default ? " · default" : ""}
                    </small>
                  </div>
                  <div className="choice-row">
                    <button
                      className={item.can_send ? "selected" : ""}
                      onClick={() =>
                        void updateMailbox(item, { can_send: !item.can_send })
                      }
                    >
                      Send
                    </button>
                    <button
                      className={item.can_receive ? "selected" : ""}
                      onClick={() =>
                        void updateMailbox(item, {
                          can_receive: !item.can_receive,
                        })
                      }
                    >
                      Receive
                    </button>
                    {!item.is_default && (
                      <button
                        onClick={() =>
                          void updateMailbox(item, { is_default: true })
                        }
                      >
                        Default
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "integrations" && (
          <div className="settings-grid">
            <div className="setting-card">
              <h3>Optional connections</h3>
              <p>
                Calendar, OneDrive, Teams, Google Drive, and AI can be attached
                here without putting provider secrets in the browser.
              </p>
              <div className="integration-row">
                <span>Google Calendar</span>
                <small>
                  Connect through OAuth when credentials are configured.
                </small>
              </div>
              <div className="integration-row">
                <span>Microsoft Graph</span>
                <small>Mail and Teams connectors are not configured.</small>
              </div>
              <div className="integration-row">
                <span>AI assistant</span>
                <small>Optional and disabled by default.</small>
              </div>
            </div>
          </div>
        )}
        {notice && <div className="form-notice">{notice}</div>}
      </section>
    </div>
  );
}

type JsonSettings = Record<string, unknown>;

function Workspace({
  mode,
  tasks,
  events,
  workItems,
  workSummary,
  onOpenMessage,
  onRefresh,
}: {
  mode: "calendar" | "tasks";
  tasks: Task[];
  events: CalendarEvent[];
  workItems: WorkItem[];
  workSummary: WorkSummary;
  onOpenMessage: (message: Message) => void;
  onRefresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  async function addTask() {
    if (!title.trim()) return;
    setError("");
    try {
      await apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title,
          dueAt: date ? new Date(date).toISOString() : null,
        }),
      });
      setTitle("");
      setDate("");
      onRefresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save the task",
      );
    }
  }
  async function addEvent() {
    if (!title.trim()) return;
    setError("");
    try {
      const start = date
        ? new Date(date)
        : new Date(Date.now() + 60 * 60 * 1000);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      await apiFetch("/api/calendar", {
        method: "POST",
        body: JSON.stringify({
          title,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
        }),
      });
      setTitle("");
      setDate("");
      onRefresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save the event",
      );
    }
  }
  async function toggleTask(task: Task) {
    setError("");
    try {
      await apiFetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ completed: !task.completed }),
      });
      onRefresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update the task",
      );
    }
  }
  return (
    <section className="workspace-view">
      <div className="workspace-head">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>
            {mode === "calendar" ? (
              <>
                <CalendarDays size={23} /> Calendar
              </>
            ) : (
              <>
                <Briefcase size={23} /> Work
              </>
            )}
          </h1>
        </div>
        <div className="workspace-stamp">
          {mode === "calendar"
            ? "Events from email can become appointments."
            : "Keep promises, follow-ups, and next actions in one queue."}
        </div>
      </div>
      {error && <div className="inline-error workspace-error">{error}</div>}
      {mode === "tasks" && (
        <div className="work-summary" aria-label="Work summary">
          <div className="work-summary-card"><span>Reply later</span><strong>{workSummary.reply_later}</strong></div>
          <div className="work-summary-card"><span>Waiting on</span><strong>{workSummary.waiting_on}</strong></div>
          <div className="work-summary-card"><span>I owe</span><strong>{workSummary.i_owe}</strong></div>
          <div className={`work-summary-card ${workSummary.overdue ? "overdue" : ""}`}><span>Overdue</span><strong>{workSummary.overdue}</strong></div>
        </div>
      )}
      <div className="workspace-grid">
        <div className="setting-card workspace-create">
          <h3>{mode === "calendar" ? "Add an event" : "Add a task"}</h3>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={mode === "calendar" ? "Event title" : "Task title"}
          />
          <input
            type={mode === "calendar" ? "datetime-local" : "datetime-local"}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <button
            className="primary-button"
            onClick={() => void (mode === "calendar" ? addEvent() : addTask())}
          >
            <Plus size={15} /> Add {mode === "calendar" ? "event" : "task"}
          </button>
        </div>
        <div className="workspace-list">
          {mode === "calendar" ? (
            events.length ? (
              events.map((event) => (
                <article className="event-card" key={event.id}>
                  <div className="event-time">
                    {formatDate(event.starts_at)}
                  </div>
                  <div>
                    <strong>{event.title}</strong>
                    <p>{new Date(event.starts_at).toLocaleString()}</p>
                  </div>
                </article>
              ))
            ) : (
              <div className="list-empty">
                <CalendarDays size={25} />
                <p>No events yet.</p>
              </div>
            )
          ) : (
            <>
              <div className="work-queue-head"><div><p className="eyebrow">MESSAGE QUEUE</p><h3>Follow-ups</h3></div><span>{workItems.length} open</span></div>
              {workItems.length ? workItems.map((item) => (
                <article className={`work-item ${item.overdue ? "overdue" : ""}`} key={item.id}>
                  <button onClick={() => onOpenMessage(item)} className="work-item-main">
                    <span className="work-state-label">{workStateLabel(item.work_state)}</span>
                    <strong>{item.subject || "(no subject)"}</strong>
                    <small>{item.from_address} · {workDueLabel(item.follow_up_at)}</small>
                    {item.work_note && <em>{item.work_note}</em>}
                  </button>
                  <button className="icon-button compact-icon" onClick={() => onOpenMessage(item)} aria-label={`Open ${item.subject || "message"}`} title="Open message"><ArrowDown size={14} className="open-work-icon" /></button>
                </article>
              )) : <div className="list-empty compact-empty"><Briefcase size={25} /><p>No message follow-ups yet.</p><small>Use Reply later, Waiting on, or I owe from a message.</small></div>}
              <div className="work-queue-head task-queue-head"><div><p className="eyebrow">TASKS</p><h3>To Do</h3></div><span>{tasks.filter((task) => !task.completed).length} open</span></div>
              {tasks.length ? tasks.map((task) => (
                <label className={`task-card ${task.completed ? "completed" : ""}`} key={task.id}>
                  <input type="checkbox" checked={task.completed} onChange={() => void toggleTask(task)} />
                  <span><strong>{task.title}</strong><small>{task.due_at ? `Due ${new Date(task.due_at).toLocaleString()}` : "No due date"}</small></span>
                </label>
              )) : <div className="list-empty compact-empty"><ListTodo size={25} /><p>No tasks yet.</p></div>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function MailboxApp({ session }: { session: Session }) {
  const [view, setView] = useState<"mail" | "calendar" | "tasks">("mail");
  const [folder, setFolder] = useState<ViewKey>("inbox");
  const [messages, setMessages] = useState<Message[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [folders, setFolders] = useState<CustomFolder[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [senderPolicies, setSenderPolicies] = useState<SenderPolicy[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    theme: "light",
    density: "comfortable",
    focused_inbox_enabled: true,
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workSummary, setWorkSummary] = useState<WorkSummary>({ reply_later: 0, waiting_on: 0, i_owe: 0, overdue: 0, total: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Message | null>(null);
  const [threadMessages, setThreadMessages] = useState<Message[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequestRef = useRef(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSeed, setComposeSeed] = useState<ComposeSeed | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [liveState, setLiveState] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [showAllThreadMessages, setShowAllThreadMessages] = useState(false);
  const [showMessageDetails, setShowMessageDetails] = useState(false);
  const [trustLensOpen, setTrustLensOpen] = useState(false);
  const [trustLensBusy, setTrustLensBusy] = useState(false);
  const [trustData, setTrustData] = useState<TrustData | null>(null);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [trashBusy, setTrashBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllResults, setSelectAllResults] = useState(false);
  const [bulkAction, setBulkAction] = useState("archive");
  const [bulkFolder, setBulkFolder] = useState("archive");
  const [bulkLabelId, setBulkLabelId] = useState("");
  const [bulkPriority, setBulkPriority] = useState("1");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState("");
  const [bulkUndo, setBulkUndo] = useState<{ requestId: string; label: string } | null>(null);
  const [savedSearchFormOpen, setSavedSearchFormOpen] = useState(false);
  const [savedSearchName, setSavedSearchName] = useState("");
  const [savedSearchBusy, setSavedSearchBusy] = useState(false);
  const [activeSavedSearchId, setActiveSavedSearchId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [resultTotal, setResultTotal] = useState<number | null>(null);
  const previousMessageIds = useRef<Set<string>>(new Set());
  const loadMeta = useCallback(async () => {
    try {
      const [addresses, contactRows, customFolders, labelRows, signatureRows, ruleRows, policyRows, preference, savedRows] =
        await Promise.all([
          apiFetch<Mailbox[]>("/api/mailboxes"),
          apiFetch<Contact[]>("/api/contacts"),
          apiFetch<CustomFolder[]>("/api/folders"),
          apiFetch<Label[]>("/api/labels"),
          apiFetch<Signature[]>("/api/signatures"),
          apiFetch<Rule[]>("/api/rules"),
          apiFetch<SenderPolicy[]>("/api/sender-policies").catch(() => []),
          apiFetch<AppSettings>("/api/settings"),
          apiFetch<SavedSearch[]>("/api/saved-searches?counts=true").catch(() => []),
        ]);
      setMailboxes(addresses);
      setContacts(contactRows);
      setFolders(customFolders);
      setLabels(labelRows);
      setSignatures(signatureRows);
      setRules(ruleRows);
      setSenderPolicies(policyRows);
      setSettings(preference);
      setSavedSearches(savedRows);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Mailbox settings unavailable",
      );
    }
  }, []);
  const loadMessages = useCallback(
    async (target: ViewKey = folder, showLoading = true, pageNumber = 1, append = false) => {
      if (showLoading) setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          folder: target,
          page: String(pageNumber),
          page_size: "80",
          filter,
          sort,
        });
        if (query.trim()) params.set("q", query.trim());
        params.set("meta", "true");
        const payload = await apiFetch<MailPage | Message[]>(`/api/mail?${params.toString()}`);
        const nextPage = Array.isArray(payload) ? { items: payload, total: null, page: pageNumber, hasMore: payload.length >= 80 } : payload;
        setMessages((current) => (append ? [...current, ...nextPage.items] : nextPage.items));
        setPage(nextPage.page);
        setHasMore(nextPage.hasMore);
        setResultTotal(nextPage.total);
        if (pageNumber === 1 && !append) void apiFetch<SavedSearch[]>("/api/saved-searches?counts=true").then(setSavedSearches).catch(() => undefined);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Mailbox unavailable",
        );
      } finally {
        setLoading(false);
      }
    },
    [filter, folder, query, sort],
  );
  useEffect(() => {
    if (!bulkUndo) return;
    const timer = window.setTimeout(() => setBulkUndo(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [bulkUndo]);
  const loadWorkspace = useCallback(async () => {
    try {
      const [taskRows, eventRows, workRows, summary] = await Promise.all([
        apiFetch<Task[]>("/api/tasks"),
        apiFetch<CalendarEvent[]>("/api/calendar"),
        apiFetch<WorkItem[]>("/api/work"),
        apiFetch<WorkSummary>("/api/work/summary"),
      ]);
      setTasks(taskRows);
      setEvents(eventRows);
      setWorkItems(workRows);
      setWorkSummary(summary);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Workspace unavailable",
      );
    }
  }, []);
  function clearListSelection() {
    setSelectedIds(new Set());
    setSelectAllResults(false);
  }
  function openMailFolder(target: ViewKey) {
    detailRequestRef.current += 1;
    setView("mail");
    setFolder(target);
    setActiveSavedSearchId(null);
    setSelected(null);
    setSelectedId(null);
    setThreadMessages([]);
    setDetailLoading(false);
    clearListSelection();
    setMobileNav(false);
  }
  function toggleMessageSelection(id: string) {
    if (selectAllResults) {
      setSelectedIds(new Set(messages.map((message) => message.id).filter((messageId) => messageId !== id)));
      setSelectAllResults(false);
      return;
    }
    setSelectAllResults(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectCurrentPage() {
    setSelectedIds(new Set(messages.map((message) => message.id)));
    setSelectAllResults(false);
  }
  async function createSavedSearch() {
    const queryText = query.trim();
    const name = savedSearchName.trim();
    if (!name) { setError("Enter a name for the saved search"); return; }
    if (!queryText) { setError("Enter a search query before saving it"); return; }
    setSavedSearchBusy(true);
    setError("");
    try {
      const saved = await apiFetch<SavedSearch>("/api/saved-searches", { method: "POST", body: JSON.stringify({ name, query: queryText }) });
      setSavedSearches((current) => [...current, saved].sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name)));
      setSavedSearchName("");
      setSavedSearchFormOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Saved search could not be created");
    } finally {
      setSavedSearchBusy(false);
    }
  }
  async function renameSavedSearch(saved: SavedSearch) {
    const name = window.prompt("Rename saved search", saved.name)?.trim();
    if (!name || name === saved.name) return;
    try {
      const updated = await apiFetch<SavedSearch>(`/api/saved-searches/${saved.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setSavedSearches((current) => current.map((item) => item.id === saved.id ? { ...item, ...updated } : item));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Saved search could not be renamed");
    }
  }
  async function deleteSavedSearch(saved: SavedSearch) {
    if (!window.confirm(`Delete saved search “${saved.name}”? Your messages will not be changed.`)) return;
    try {
      await apiFetch(`/api/saved-searches/${saved.id}`, { method: "DELETE" });
      setSavedSearches((current) => current.filter((item) => item.id !== saved.id));
      if (activeSavedSearchId === saved.id) {
        setActiveSavedSearchId(null);
        setQuery("");
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Saved search could not be deleted");
    }
  }
  async function reorderSavedSearch(saved: SavedSearch, direction: -1 | 1) {
    const ordered = [...savedSearches].sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));
    const index = ordered.findIndex((item) => item.id === saved.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setSavedSearches(ordered.map((item, itemIndex) => ({ ...item, sort_order: itemIndex })));
    try {
      await apiFetch("/api/saved-searches/reorder", { method: "POST", body: JSON.stringify({ ids: ordered.map((item) => item.id) }) });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Saved searches could not be reordered");
    }
  }
  function openSavedSearch(saved: SavedSearch) {
    openMailFolder("inbox");
    setQuery(saved.query);
    setActiveSavedSearchId(saved.id);
  }
  async function undoBulkAction() {
    if (!bulkUndo) return;
    const requestId = bulkUndo.requestId;
    try {
      await apiFetch("/api/mail/bulk/undo", { method: "POST", body: JSON.stringify({ requestId }) });
      setBulkUndo(null);
      setBulkNotice("Bulk change undone");
      await loadMessages(folder, false);
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : "Undo is no longer available");
    }
  }
  async function runBulkAction() {
    const allResults = selectAllResults;
    const visibleSelection = allResults ? messages.map((message) => message.id) : [...selectedIds];
    if (!visibleSelection.length && !allResults) { setError("Select at least one message"); return; }
    const countLabel = allResults ? `${resultTotal ?? "all"} matching messages` : `${visibleSelection.length} message${visibleSelection.length === 1 ? "" : "s"}`;
    if (bulkAction === "trash" && !window.confirm(`Move ${countLabel} to Trash? You can restore them later.`)) return;
    setBulkBusy(true);
    setError("");
    setBulkNotice("");
    const action: JsonSettings = { type: bulkAction };
    if (bulkAction === "move") {
      if (bulkFolder.startsWith("custom:")) {
        action.folder = "custom";
        action.customFolderId = bulkFolder.slice(7);
      } else {
        action.folder = bulkFolder;
      }
    }
    if (bulkAction === "label") {
      if (!bulkLabelId) { setError("Choose a label first"); setBulkBusy(false); return; }
      action.labelId = bulkLabelId;
    }
    if (bulkAction === "priority") action.priority = Number(bulkPriority);
    const idempotencyKey = crypto.randomUUID();
    try {
      const payload = await apiFetch<{ requestId: string; changedIds: string[]; exported?: JsonSettings[]; failures: Array<{ id: string; error: string }>; undoable: boolean; truncated?: boolean }>("/api/mail/bulk", {
        method: "POST",
        body: JSON.stringify({ messageIds: visibleSelection, scope: allResults ? "all_results" : "selected", query: query.trim(), folder, action, idempotencyKey }),
      });
      const movedOut = ["archive", "move", "trash", "spam", "restore", "snooze"].includes(bulkAction);
      const selectedSet = new Set(payload.changedIds);
      setMessages((current) => movedOut ? current.filter((message) => !selectedSet.has(message.id)) : current.map((message) => {
        if (!selectedSet.has(message.id)) return message;
        if (bulkAction === "mark_read" || bulkAction === "mark_unread") return { ...message, is_read: bulkAction === "mark_read" };
        if (bulkAction === "star" || bulkAction === "unstar") return { ...message, is_starred: bulkAction === "star" };
        if (bulkAction === "pin" || bulkAction === "unpin") return { ...message, is_pinned: bulkAction === "pin" };
        if (bulkAction === "flag" || bulkAction === "unflag") return { ...message, is_flagged: bulkAction === "flag" };
        return message;
      }));
      clearListSelection();
      await loadMessages(folder, false);
      if (bulkAction === "export" && payload.exported?.length) {
        const download = document.createElement("a");
        download.href = URL.createObjectURL(new Blob([JSON.stringify(payload.exported, null, 2)], { type: "application/json" }));
        download.download = `parcel-export-${new Date().toISOString().slice(0, 10)}.json`;
        download.click();
        URL.revokeObjectURL(download.href);
      }
      if (payload.failures.length) setError(`${payload.changedIds.length} changed; ${payload.failures.length} failed. ${payload.failures[0].error}`);
      else setBulkNotice(`${payload.changedIds.length || (bulkAction === "export" ? visibleSelection.length : 0)} message${payload.changedIds.length === 1 ? "" : "s"} updated${payload.truncated ? " (first 500 matching messages)" : ""}`);
      if (payload.undoable && payload.changedIds.length) setBulkUndo({ requestId: payload.requestId, label: "Undo change" });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Bulk action failed");
    } finally {
      setBulkBusy(false);
    }
  }
  useEffect(() => {
    void loadMeta();
    void loadWorkspace();
  }, [loadMeta, loadWorkspace]);
  useEffect(() => {
    if (
      settings.desktop_notifications &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    )
      void Notification.requestPermission();
  }, [settings.desktop_notifications]);
  useEffect(() => {
    const nextIds = new Set(messages.map((message) => message.id));
    const previousIds = previousMessageIds.current;
    if (
      previousIds.size > 0 &&
      folder === "inbox" &&
      settings.desktop_notifications &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      messages
        .filter((message) => !previousIds.has(message.id) && !message.is_read)
        .slice(0, 3)
        .forEach(
          (message) =>
            new Notification(message.subject || "New message", {
              body: `${message.from_address}: ${message.snippet || "Open Parcel to read it."}`,
            }),
        );
    }
    previousMessageIds.current = nextIds;
  }, [folder, messages, settings.desktop_notifications]);
  useEffect(() => {
    if (view !== "mail") return;
    void loadMessages(folder, true);
    const interval = window.setInterval(
      () => void loadMessages(folder, false),
      15000,
    );
    let channel:
      | ReturnType<NonNullable<typeof supabase>["channel"]>
      | undefined;
    if (supabase) {
      setLiveState("connecting");
      channel = supabase
        .channel(`messages-${folder}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "messages", filter: `owner_id=eq.${session.user.id}` },
          () => void loadMessages(folder, false),
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setLiveState("live");
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setLiveState("reconnecting");
          else if (status === "CLOSED") setLiveState("offline");
        });
    } else {
      setLiveState("offline");
    }
    return () => {
      window.clearInterval(interval);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [folder, view, loadMessages]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (view === "mail") void loadMessages(folder, false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, filter, sort, folder, view, loadMessages]);
  async function openMessage(message: Message) {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setView("mail");
    if (["inbox", "sent", "drafts", "archive", "trash", "spam"].includes(message.folder)) setFolder(message.folder as ViewKey);
    setSelectedId(message.id);
    setSelected(message);
    setDetailLoading(true);
    setError("");
    setShowAllThreadMessages(false);
    setShowMessageDetails(false);
    setThreadMessages([]);
    setTrustLensOpen(false);
    setTrustData(null);
    setShowMoreActions(false);
    try {
      const detail = await apiFetch<Message>(`/api/mail/${message.id}`);
      if (detailRequestRef.current !== requestId) return;
      setSelected(detail);
      const thread = await apiFetch<Message[]>(`/api/threads/${message.thread_id}`);
      if (detailRequestRef.current !== requestId) return;
      setThreadMessages(thread);
      if (!message.is_read) {
        await apiFetch(`/api/mail/${message.id}`, {
          method: "POST",
          body: JSON.stringify({ isRead: true }),
        });
        if (detailRequestRef.current !== requestId) return;
        setMessages((current) =>
          current.map((item) =>
            item.id === message.id ? { ...item, is_read: true } : item,
          ),
        );
      }
    } catch (openError) {
      if (detailRequestRef.current !== requestId) return;
      setError(
        openError instanceof Error ? openError.message : "Message unavailable",
      );
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }
  async function toggleTrustLens() {
    if (!selected) return;
    if (trustLensOpen) { setTrustLensOpen(false); return; }
    setTrustLensOpen(true);
    if (trustData) return;
    setTrustLensBusy(true);
    try { setTrustData(await apiFetch<TrustData>(`/api/mail/${selected.id}/trust`)); }
    catch (trustError) { setError(trustError instanceof Error ? trustError.message : "Trust details unavailable"); }
    finally { setTrustLensBusy(false); }
  }
  async function submitSpamFeedback(feedback: "spam" | "not_spam") {
    if (!selected) return;
    try {
      await apiFetch(`/api/mail/${selected.id}/feedback`, { method: "POST", body: JSON.stringify({ feedback }) });
      setSelected(null);
      setSelectedId(null);
      setThreadMessages([]);
      setTrustData(null);
      await loadMessages(folder, false);
    } catch (feedbackError) {
      setError(feedbackError instanceof Error ? feedbackError.message : "Feedback could not be saved");
    }
  }
  async function mutateMessage(body: JsonSettings) {
    if (!selected) return;
    try {
      await apiFetch(`/api/mail/${selected.id}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await loadMessages(folder, false);
      if (body.workState !== undefined || body.followUpAt !== undefined || body.workNote !== undefined) void loadWorkspace();
      if (typeof body.folder === "string" || typeof body.snoozedUntil === "string") {
        setSelected(null);
        setSelectedId(null);
        setThreadMessages([]);
        return;
      }
      const detail = await apiFetch<Message>(`/api/mail/${selected.id}`);
      setSelected(detail);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Action failed",
      );
    }
  }
  function clearMessageSelection() {
    detailRequestRef.current += 1;
    setSelected(null);
    setSelectedId(null);
    setThreadMessages([]);
    setDetailLoading(false);
    setTrustLensOpen(false);
    setTrustData(null);
    setShowMoreActions(false);
  }
  async function restoreSelected() {
    if (!selected || selected.folder !== "trash") return;
    setTrashBusy(true);
    setError("");
    try {
      await apiFetch(`/api/mail/${selected.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "restore" }),
      });
      clearMessageSelection();
      await loadMessages(folder, false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Restore failed");
    } finally {
      setTrashBusy(false);
    }
  }
  async function permanentlyDeleteSelected() {
    if (!selected || selected.folder !== "trash") return;
    if (!window.confirm("Delete this message permanently? This cannot be undone.")) return;
    setTrashBusy(true);
    setError("");
    try {
      await apiFetch(`/api/mail/${selected.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "permanent_delete" }),
      });
      clearMessageSelection();
      await loadMessages(folder, false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Permanent delete failed");
    } finally {
      setTrashBusy(false);
    }
  }
  async function emptyTrash() {
    if (!window.confirm("Empty Trash permanently? Messages and attachments in Trash cannot be recovered.")) return;
    setTrashBusy(true);
    setError("");
    try {
      await apiFetch<{ ok: boolean; deleted: number }>("/api/trash/empty", {
        method: "POST",
      });
      clearMessageSelection();
      await loadMessages("trash", false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Trash could not be emptied");
    } finally {
      setTrashBusy(false);
    }
  }
  async function assignLabel(labelId: string) {
    if (!selected) return;
    try {
      await apiFetch("/api/labels/assign", {
        method: "POST",
        body: JSON.stringify({ messageId: selected.id, labelId }),
      });
      setError("");
    } catch (labelError) {
      setError(
        labelError instanceof Error
          ? labelError.message
          : "Label assignment failed",
      );
    }
  }
  async function openAttachment(id: string) {
    try {
      const result = await apiFetch<{ url: string }>(
        `/api/attachments/${id}?json=true`,
      );
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (attachmentError) {
      setError(
        attachmentError instanceof Error
          ? attachmentError.message
          : "Attachment unavailable",
      );
    }
  }
  async function previewAttachment(id: string) {
    try {
      const result = await apiFetch<{ url: string }>(`/api/attachments/${id}/preview`);
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (attachmentError) {
      setError(attachmentError instanceof Error ? attachmentError.message : "Preview unavailable");
    }
  }
  async function downloadAllAttachments(messageId: string) {
    try {
      const session = (await requireSupabase().auth.getSession()).data.session;
      const response = await fetch(`/api/messages/${messageId}/attachments/download`, { headers: session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {} });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Attachment download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "attachments.zip";
      link.click();
      URL.revokeObjectURL(url);
    } catch (attachmentError) {
      setError(attachmentError instanceof Error ? attachmentError.message : "Attachment download failed");
    }
  }
  async function cancelSelectedSend() {
    if (!selected || !["queued", "scheduled"].includes(selected.status)) return;
    try {
      await apiFetch(`/api/outbox/${selected.id}/cancel`, { method: "POST" });
      await loadMessages(folder, false);
      await openMessage({ ...selected, status: "draft", folder: "drafts", cancelled_at: new Date().toISOString() });
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Send could not be cancelled");
    }
  }
  function openCompose(seed?: ComposeSeed) {
    setComposeSeed(seed);
    setComposeOpen(true);
  }
  const activeSavedSearch = activeSavedSearchId ? savedSearches.find((item) => item.id === activeSavedSearchId) : undefined;
  const currentLabel = activeSavedSearch
    ? activeSavedSearch.name
    : folder === "focused"
      ? "Focused"
      : folder === "other"
        ? "Other"
        : folder.startsWith("custom:")
          ? folders.find((item) => item.id === folder.slice(7))?.name ||
            "Folder"
          : folderNames[folder as SystemFolder];
  const CurrentIcon = activeSavedSearch
    ? Bookmark
    : folder === "focused" || folder === "other" || folder.startsWith("custom:")
      ? Mail
      : folderIcons[folder as SystemFolder];
  const unread = messages.filter((message) => !message.is_read).length;
  const selectedReplySeed = selected
    ? {
        to:
          selected.direction === "inbound"
            ? selected.from_address
            : selected.to_addresses?.[0],
        subject: selected.subject.startsWith("Re:")
          ? selected.subject
          : `Re: ${selected.subject}`,
        text: `\n\n— Original message —\n${selected.text_body || selected.snippet}`,
        threadId: selected.thread_id,
        inReplyTo: selected.message_id_header || undefined,
        references: [selected.references_header, selected.message_id_header]
          .filter(Boolean)
          .join(" "),
      }
    : undefined;
  const selectedReplyAllSeed = selected
    ? {
        ...selectedReplySeed,
        to:
          selected.direction === "inbound"
            ? selected.from_address
            : selected.to_addresses.join(", "),
        cc: [
          ...(selected.cc_addresses || []),
          ...(selected.direction === "inbound" ? selected.to_addresses : []),
        ]
          .filter(
            (address) =>
              address.toLowerCase() !==
              (session.user.email || "").toLowerCase(),
          )
          .join(", "),
      }
    : undefined;
  const selectedBody = selected
    ? splitQuotedBody(selected.text_body || selected.snippet || "")
    : { body: "", quote: "" };
  const detailIdentity = selected
    ? detailIdentityForMessage(selected, contacts, mailboxes)
    : null;
  const selectedHtml = selected ? sanitizeEmailHtml(selected.html_body) : "";
  return (
    <main
      className={`app-shell theme-${settings.theme || "light"} density-${settings.density || "comfortable"}`}
    >
      <header className="mobile-topbar">
        <button
          className="icon-button"
          onClick={() => setMobileNav(!mobileNav)}
          aria-label="Open navigation"
        >
          <Menu size={19} />
        </button>
        <div className="mini-brand">
          <span>P</span> Parcel
        </div>
        <button
          className="icon-button"
          onClick={() => void loadMessages()}
          aria-label="Refresh"
        >
          <RefreshCcw size={17} />
        </button>
      </header>
      <aside className={`sidebar ${mobileNav ? "mobile-visible" : ""}`}>
        <div className="sidebar-top">
          <div className="brand-lockup">
            <div className="brand-mark small">P</div>
            <div>
              <strong>Parcel</strong>
              <span>private mail</span>
            </div>
          </div>
          <button
            className="icon-button mobile-close"
            onClick={() => setMobileNav(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="compose-button"
          onClick={() => {
            openCompose();
            setMobileNav(false);
          }}
        >
          <PenLine size={17} /> Compose
        </button>
        <nav className="folder-nav" aria-label="Mailbox folders">
          <button
            className={`folder-link ${view === "mail" && folder === "inbox" ? "active" : ""}`}
            onClick={() => openMailFolder("inbox")}
          >
            <Inbox size={17} />
            <span>Inbox</span>
            {unread > 0 && <em>{unread}</em>}
          </button>
          <button
            className={`folder-link ${view === "mail" && folder === "focused" ? "active" : ""}`}
            onClick={() => openMailFolder("focused")}
          >
            <Eye size={17} />
            <span>Focused</span>
          </button>
          <button
            className={`folder-link ${view === "mail" && folder === "other" ? "active" : ""}`}
            onClick={() => openMailFolder("other")}
          >
            <Mail size={17} />
            <span>Other</span>
          </button>
          {(
            ["sent", "drafts", "archive", "trash", "spam"] as SystemFolder[]
          ).map((item) => {
            const Icon = folderIcons[item];
            return (
              <button
                key={item}
                className={`folder-link ${view === "mail" && folder === item ? "active" : ""}`}
                onClick={() => openMailFolder(item)}
              >
                <Icon size={17} />
                <span>{folderNames[item]}</span>
              </button>
            );
          })}
          {folders.map((customFolder) => (
            <button
              key={customFolder.id}
              className={`folder-link ${view === "mail" && folder === `custom:${customFolder.id}` ? "active" : ""}`}
              onClick={() => openMailFolder(`custom:${customFolder.id}`)}
            >
              <Tag size={17} color={customFolder.color} />
              <span>{customFolder.name}</span>
            </button>
          ))}
        </nav>
        <section className="saved-searches" aria-label="Saved searches">
          <div className="saved-search-head">
            <span className="eyebrow">SAVED SEARCHES</span>
            <button
              className="icon-button compact-icon"
              onClick={() => setSavedSearchFormOpen((current) => !current)}
              aria-label="Create saved search"
              title="Create saved search from the current query"
            >
              <Plus size={15} />
            </button>
          </div>
          {savedSearchFormOpen && (
            <div className="saved-search-form">
              <input
                value={savedSearchName}
                onChange={(event) => setSavedSearchName(event.target.value)}
                placeholder="Search name"
                aria-label="Saved search name"
                maxLength={80}
              />
              <small>{query.trim() ? `Saves: ${query.trim()}` : "Type a query first"}</small>
              <button className="primary-button" onClick={() => void createSavedSearch()} disabled={savedSearchBusy || !query.trim()}>
                {savedSearchBusy ? "Saving…" : "Save search"}
              </button>
            </div>
          )}
          <div className="saved-search-list">
            {savedSearches.map((saved) => (
              <div className={`saved-search-row ${activeSavedSearchId === saved.id ? "active" : ""}`} key={saved.id}>
                <button className="saved-search-link" onClick={() => openSavedSearch(saved)} title={saved.query}>
                  <Bookmark size={15} color={saved.color} />
                  <span>{saved.name}</span>
                  <em>{saved.result_count ?? "—"}</em>
                </button>
                <div className="saved-search-controls">
                  <button className="icon-button compact-icon" onClick={() => void reorderSavedSearch(saved, -1)} aria-label={`Move ${saved.name} up`} title="Move up"><ArrowUp size={12} /></button>
                  <button className="icon-button compact-icon" onClick={() => void reorderSavedSearch(saved, 1)} aria-label={`Move ${saved.name} down`} title="Move down"><ArrowDown size={12} /></button>
                  <button className="icon-button compact-icon" onClick={() => void renameSavedSearch(saved)} aria-label={`Rename ${saved.name}`} title="Rename"><Pencil size={12} /></button>
                  <button className="icon-button compact-icon danger-icon" onClick={() => void deleteSavedSearch(saved)} aria-label={`Delete ${saved.name}`} title="Delete"><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            {savedSearches.length === 0 && !savedSearchFormOpen && <small className="saved-search-empty">Save a query here for one-click access.</small>}
          </div>
        </section>
        <div className="sidebar-divider" />
        <nav className="folder-nav secondary-nav">
          <button
            className={
              view === "calendar" ? "active folder-link" : "folder-link"
            }
            onClick={() => setView("calendar")}
          >
            <CalendarDays size={17} />
            <span>Calendar</span>
          </button>
          <button
            className={view === "tasks" ? "active folder-link" : "folder-link"}
            onClick={() => setView("tasks")}
          >
            <Briefcase size={17} />
            <span>Work</span>
            {workSummary.total > 0 && <em className="nav-count">{workSummary.total}</em>}
            {workSummary.overdue > 0 && <em className="nav-overdue">{workSummary.overdue} due</em>}
          </button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="account-chip">
          <div className="avatar">
            {(session.user.email || "J").slice(0, 1).toUpperCase()}
          </div>
          <div className="account-text">
            <strong>{displayName(session.user.email || "James")}</strong>
            <span>{session.user.email}</span>
          </div>
          <button
            className="icon-button"
            onClick={() => void requireSupabase().auth.signOut()}
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {view === "mail" ? (
        <>
          <section className="message-column">
            <div className="column-head">
              <div>
                <p className="eyebrow">INBOX VIEW</p>
                <h1>
                  <CurrentIcon size={22} /> {currentLabel}
                </h1>
              </div>
              <div className="head-actions">
                {folder === "trash" && (
                  <button
                    className="secondary-button trash-empty-button"
                    onClick={() => void emptyTrash()}
                    disabled={trashBusy || messages.length === 0}
                    title="Permanently delete every message in Trash"
                  >
                    <Trash2 size={14} /> Empty trash
                  </button>
                )}
                <button
                  className="icon-button"
                  onClick={() => void loadMessages()}
                  aria-label="Refresh messages"
                >
                  <RefreshCcw size={17} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Settings"
                >
                  <Settings2 size={17} />
                </button>
              </div>
            </div>
            <div className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveSavedSearchId(null);
                  clearListSelection();
                }}
                placeholder="Search messages, people, or files"
              />
              <select
                value={filter}
                 onChange={(event) => {
                   clearListSelection();
                   setFilter(event.target.value);
                 }}
                aria-label="Filter messages"
              >
                <option value="all">All mail</option>
                <option value="unread">Unread</option>
                <option value="starred">Starred</option>
                <option value="attachments">Attachments</option>
              </select>
              <select
                value={sort}
                 onChange={(event) => {
                   clearListSelection();
                   setSort(event.target.value);
                 }}
                aria-label="Sort messages"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </div>
            <div className={`sync-status sync-${liveState}`} role="status" aria-live="polite">
              <span className="sync-dot" />
              {liveState === "live" ? "Live updates" : liveState === "connecting" ? "Connecting to live updates…" : liveState === "reconnecting" ? "Reconnecting…" : "Polling for updates"}
            </div>
            {error && <div className="inline-error">{error}</div>}
            {!loading && messages.length > 0 && (
              <div className="selection-bar" aria-label="Message selection controls">
                <label>
                  <input
                    type="checkbox"
                    checked={selectAllResults || messages.every((message) => selectedIds.has(message.id))}
                    onChange={(event) => event.target.checked ? selectCurrentPage() : clearListSelection()}
                    aria-label="Select all messages on this page"
                  />
                  <span>Select page</span>
                </label>
                <span className="selection-count">{resultTotal ?? messages.length} result{(resultTotal ?? messages.length) === 1 ? "" : "s"}</span>
                {selectedIds.size > 0 && !selectAllResults && <button className="text-button" onClick={clearListSelection}>Clear</button>}
                {query.trim() && !selectAllResults && selectedIds.size === messages.length && resultTotal !== null && resultTotal > messages.length && (
                  <button className="text-button selection-all-button" onClick={() => setSelectAllResults(true)}>Select all {resultTotal} results</button>
                )}
                {selectAllResults && <span className="selection-all-label">All matching results selected</span>}
              </div>
            )}
            {(selectedIds.size > 0 || selectAllResults) && (
              <div className="bulk-toolbar" aria-label="Bulk message actions">
                <strong>{selectAllResults ? `${resultTotal ?? "All"} selected` : `${selectedIds.size} selected`}</strong>
                <select value={bulkAction} onChange={(event) => setBulkAction(event.target.value)} aria-label="Bulk action">
                  <option value="archive">Archive</option>
                  <option value="move">Move to…</option>
                  <option value="mark_read">Mark read</option>
                  <option value="mark_unread">Mark unread</option>
                  <option value="star">Star</option>
                  <option value="unstar">Unstar</option>
                  <option value="flag">Flag</option>
                  <option value="unflag">Unflag</option>
                  <option value="priority">Set priority</option>
                  {labels.length > 0 && <option value="label">Add label…</option>}
                  <option value="snooze">Snooze 1 hour</option>
                  <option value="reply_later">Reply later</option>
                  <option value="waiting_on">Waiting on</option>
                  <option value="i_owe">I owe</option>
                  <option value="create_task">Create task</option>
                  <option value="export">Export JSON</option>
                  <option value="restore">Restore</option>
                  <option value="spam">Move to Spam</option>
                  <option value="trash">Move to Trash</option>
                </select>
                 {bulkAction === "move" && (
                   <select value={bulkFolder} onChange={(event) => setBulkFolder(event.target.value)} aria-label="Bulk destination folder">
                     {(["inbox", "sent", "drafts", "archive", "trash", "spam"] as SystemFolder[]).map((item) => <option key={item} value={item}>{folderNames[item]}</option>)}
                     {folders.map((item) => <option key={item.id} value={`custom:${item.id}`}>{item.name}</option>)}
                   </select>
                 )}
                {bulkAction === "priority" && (
                  <select value={bulkPriority} onChange={(event) => setBulkPriority(event.target.value)} aria-label="Bulk priority">
                    <option value="0">Normal</option><option value="1">Important</option><option value="2">High</option>
                  </select>
                )}
                {bulkAction === "label" && (
                  <select value={bulkLabelId} onChange={(event) => setBulkLabelId(event.target.value)} aria-label="Bulk label">
                    <option value="">Choose label</option>
                    {labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
                  </select>
                )}
                <button className="primary-button" onClick={() => void runBulkAction()} disabled={bulkBusy}>{bulkBusy ? "Applying…" : "Apply"}</button>
              </div>
            )}
            {bulkNotice && (
              <div className="inline-notice" role="status" aria-live="polite">
                <span>{bulkNotice}</span>
                {bulkUndo && <button className="text-button" onClick={() => void undoBulkAction()}>{bulkUndo.label}</button>}
              </div>
            )}
            <div className="message-list">
              {loading ? (
                <div className="list-empty">
                  <div className="pulse-dot" />
                  <p>Gathering your mail…</p>
                </div>
              ) : messages.length === 0 ? (
                <div className="list-empty">
                  <div className="empty-glyph">
                    <Mail size={22} />
                  </div>
                  <h3>
                    {folder === "trash"
                      ? "Trash is empty"
                      : currentLabel === "Inbox"
                      ? "A quiet inbox"
                      : `No mail in ${currentLabel.toLowerCase()}`}
                  </h3>
                  <p>
                    {folder === "trash"
                      ? "Deleted messages stay here until you restore or permanently remove them."
                      : "New messages and saved rules will appear here."}
                  </p>
                  {folder !== "trash" && (
                    <button className="text-button" onClick={() => openCompose()}>
                      Write the first message
                    </button>
                  )}
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message-row ${selectedId === message.id ? "selected" : ""} ${selectedIds.has(message.id) ? "bulk-selected" : ""} ${message.is_read ? "read" : "unread"}`}
                    onClick={() => void openMessage(message)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void openMessage(message);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <input
                      className="message-select-checkbox"
                      type="checkbox"
                      checked={selectedIds.has(message.id) || selectAllResults}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleMessageSelection(message.id)}
                      aria-label={`Select ${message.subject || "message"}`}
                    />
                    {(() => {
                      const sender = senderForMessage(message, contacts, mailboxes);
                      return <SenderAvatar name={sender.name} email={sender.email} avatarUrl={sender.avatarUrl} />;
                    })()}
                    <div className="row-copy">
                      <div className="row-top">
                        <strong>
                          {message.direction === "inbound"
                            ? senderForMessage(message, contacts, mailboxes).name
                            : `To ${senderForMessage(message, contacts, mailboxes).name}`}
                        </strong>
                        <time>
                          {formatDate(
                            message.received_at ||
                              message.sent_at ||
                              message.created_at,
                          )}
                        </time>
                      </div>
                      <div className="row-address">
                        {senderForMessage(message, contacts, mailboxes).email}
                      </div>
                      <div className="row-subject">
                        {message.subject || "(no subject)"}
                        {message.status !== "received" && (
                          <span className={`message-status message-status-${message.status}`}>
                            {messageStatusLabel(message)}
                          </span>
                        )}
                        {message.has_attachment && <Paperclip size={13} />}
                        {message.is_pinned && (
                          <Pin size={13} fill="currentColor" />
                        )}
                      </div>
                      <p>{message.snippet || "No preview available."}</p>
                    </div>
                    {message.spam_score && message.spam_score >= 0.35 ? (
                      <span className="score-badge">
                        {Math.round(message.spam_score * 100)}%
                      </span>
                    ) : null}
                    {message.is_starred && (
                      <Star
                        className="row-star"
                        size={15}
                        fill="currentColor"
                      />
                    )}
                  </div>
                ))
              )}
            </div>
            {!loading && hasMore && (
              <button className="load-more-button" onClick={() => void loadMessages(folder, false, page + 1, true)} disabled={bulkBusy}>
                Load more{resultTotal !== null ? ` · ${Math.max(resultTotal - messages.length, 0)} remaining` : ""}
              </button>
            )}
          </section>
          <section className="reading-pane">
            {!selected ? (
              <div className="reading-empty">
                <div className="empty-glyph large">
                  <Mail size={30} />
                </div>
                <p>Select a message to read it here.</p>
                <span>Your inbox, without the noise.</span>
              </div>
            ) : (
              <article key={selected.id} className={`message-detail ${detailLoading ? "is-detail-loading" : ""}`} aria-busy={detailLoading}>
                <div className="detail-head">
                  <div>
                    <p className="eyebrow">{selected.direction === "inbound" ? "RECEIVED" : "SENT"}</p>
                    <h2>{selected.subject || "(no subject)"}</h2>
                    <div className="detail-meta">
                      <span>{messageStatusLabel(selected)}</span>
                      {selected.spam_score !== undefined && selected.spam_score >= 0.35 && (
                        <span>
                          Spam risk {Math.round(selected.spam_score * 100)}%
                        </span>
                      )}
                      {selected.focused_category && (
                        <span>{selected.focused_category === "focused" ? "Focused" : "Other"}</span>
                      )}
                    </div>
                  </div>
                  <div className="head-actions">
                    <button
                      className="icon-button"
                      title={selected.is_starred ? "Unstar message" : "Star message"}
                      onClick={() =>
                        void mutateMessage({ isStarred: !selected.is_starred })
                      }
                      aria-label={selected.is_starred ? "Unstar message" : "Star message"}
                    >
                      <Star
                        size={17}
                        fill={selected.is_starred ? "currentColor" : "none"}
                      />
                    </button>
                    <button
                      className="icon-button"
                      title={selected.is_pinned ? "Unpin message" : "Pin message"}
                      onClick={() =>
                        void mutateMessage({ isPinned: !selected.is_pinned })
                      }
                      aria-label={selected.is_pinned ? "Unpin message" : "Pin message"}
                    >
                      <Pin
                        size={17}
                        fill={selected.is_pinned ? "currentColor" : "none"}
                      />
                    </button>
                    {selected.folder === "trash" ? (
                      <>
                        <button
                          className="icon-button"
                          title="Restore to previous folder"
                          onClick={() => void restoreSelected()}
                          aria-label="Restore message"
                          disabled={trashBusy}
                        >
                          <Undo2 size={17} />
                        </button>
                        <button
                          className="icon-button danger-icon"
                          title="Delete permanently"
                          onClick={() => void permanentlyDeleteSelected()}
                          aria-label="Delete message permanently"
                          disabled={trashBusy}
                        >
                          <Trash2 size={17} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="icon-button"
                          title="Archive message"
                          onClick={() => void mutateMessage({ folder: "archive" })}
                          aria-label="Archive message"
                        >
                          <Archive size={17} />
                        </button>
                        <button
                          className="icon-button"
                          title="Move message to trash"
                          onClick={() => void mutateMessage({ folder: "trash" })}
                          aria-label="Delete message"
                        >
                          <Trash2 size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {detailLoading && (
                  <div className="detail-loading" role="status" aria-live="polite">
                    <span className="detail-loading-dot" /> Updating message…
                  </div>
                )}
                {selected.folder === "trash" && (
                  <div className="trash-notice" role="status">
                    <Trash2 size={15} />
                    <span>This message is in Trash. Restore it to its previous folder or delete it permanently.</span>
                  </div>
                )}
                {selected.work_state && selected.work_state !== "none" && (
                  <div className={`work-state-callout ${selected.follow_up_at && new Date(selected.follow_up_at).getTime() <= Date.now() ? "overdue" : ""}`}>
                    <Briefcase size={15} />
                    <div><strong>{workStateLabel(selected.work_state)}</strong><span>{workDueLabel(selected.follow_up_at)}{selected.work_note ? ` · ${selected.work_note}` : ""}</span></div>
                    <button className="text-button" onClick={() => void mutateMessage({ workState: "none" })}>Clear</button>
                  </div>
                )}
                <div className="sender-line">
                  {detailIdentity && <SenderAvatar name={detailIdentity.name} email={detailIdentity.email} avatarUrl={detailIdentity.avatarUrl} large />}
                  <div className="sender-copy">
                    <strong>{detailIdentity?.name}</strong>
                    <small>{detailIdentity?.email}</small>
                    <span>to {selected.to_addresses?.join(", ") || "your mailbox"}</span>
                    {showMessageDetails && (
                      <dl className="sender-details">
                        <div><dt>From</dt><dd>{detailIdentity?.email || "Not available"}</dd></div>
                        <div><dt>To</dt><dd>{selected.to_addresses?.join(", ") || "Not available"}</dd></div>
                        {selected.cc_addresses && selected.cc_addresses.length > 0 && <div><dt>CC</dt><dd>{selected.cc_addresses.join(", ")}</dd></div>}
                        {selected.bcc_addresses && selected.bcc_addresses.length > 0 && <div><dt>BCC</dt><dd>{selected.bcc_addresses.join(", ")}</dd></div>}
                        {selected.reply_to && <div><dt>Reply-To</dt><dd>{selected.reply_to}</dd></div>}
                        <div><dt>Date</dt><dd>{new Date(selected.received_at || selected.sent_at || selected.created_at).toLocaleString()}</dd></div>
                        <div><dt>Message ID</dt><dd>{selected.message_id_header || "Not available"}</dd></div>
                      </dl>
                    )}
                  </div>
                  <button
                    className="details-toggle"
                    aria-expanded={showMessageDetails}
                    onClick={() => setShowMessageDetails((current) => !current)}
                  >
                    {showMessageDetails ? "Hide details" : "Details"}
                    <ChevronDown size={14} className={showMessageDetails ? "rotated" : ""} />
                  </button>
                </div>
                {selected.spam_reasons && selected.spam_reasons.length > 0 && (
                  <div className="signal-box">
                    <ShieldAlert size={15} />
                    <div>
                      <strong>Why this was flagged</strong>
                      <span>{selected.spam_reasons.join(" · ")}</span>
                    </div>
                  </div>
                )}
                {trustLensOpen && <div className="trust-lens">
                  <button className="trust-lens-toggle" onClick={() => void toggleTrustLens()} aria-expanded={trustLensOpen}>
                    <span className="trust-lens-title"><ShieldAlert size={15} /><span><strong>Trust Lens</strong><small> Authentication and sender evidence</small></span></span>
                    <span>{trustLensBusy ? "Loading…" : trustLensOpen ? "Hide" : "Inspect"} <ChevronDown size={14} className={trustLensOpen ? "rotated" : ""} /></span>
                  </button>
                  {trustLensOpen && trustData && (() => {
                    const auth = trustData.auth_results || {};
                    const evidence = trustData.trust_evidence || {};
                    const status = (key: "spf" | "dkim" | "dmarc" | "arc" | "tls") => String(trustData[`auth_${key}` as keyof TrustData] || auth[key] || "missing");
                    const statusClass = (value: string) => value === "pass" ? "trust-status-pass" : value === "missing" || value === "none" ? "trust-status-missing" : "trust-status-fail";
                    const hosts = Array.isArray(evidence.link_hosts) ? evidence.link_hosts as Array<{ host?: string; count?: number }> : [];
                    const history = trustData.screening_history || [];
                    return <div className="trust-lens-body">
                      <p className="trust-lens-note">Advisory signals only. Authentication results describe what the receiving server observed; they do not guarantee that a message is safe.</p>
                      <div className="trust-lens-grid">
                        {(["spf", "dkim", "dmarc", "arc", "tls"] as const).map((key) => <div className="trust-lens-item" key={key}><strong>{key.toUpperCase()}</strong><span className={statusClass(status(key))}>{status(key)}</span></div>)}
                      </div>
                      <div className="trust-lens-grid">
                        <div className="trust-lens-item"><strong>Sender history</strong><span>{trustData.sender_first_seen ? "First seen sender" : "Seen before"}</span></div>
                        <div className="trust-lens-item"><strong>Contact</strong><span>{trustData.known_contact ? "Known contact" : "Not in contacts"}</span></div>
                        <div className="trust-lens-item"><strong>Reply-To</strong><span className={trustData.reply_to_mismatch ? "trust-status-fail" : "trust-status-pass"}>{trustData.reply_to_mismatch ? "Different address" : "Matches sender"}</span></div>
                        <div className="trust-lens-item"><strong>Tracking pixels</strong><span>{trustData.tracking_pixel_count || 0} detected</span></div>
                      </div>
                      <div className="trust-lens-section"><strong>Link hosts · {trustData.link_count || 0} links</strong>{hosts.length ? <div className="trust-host-list">{hosts.map((item) => <span className="trust-host" key={item.host}>{item.host}{item.count && item.count > 1 ? ` · ${item.count}` : ""}</span>)}</div> : <p className="trust-lens-note">No web links detected.</p>}</div>
                      {history.length > 0 && <div className="trust-lens-section"><strong>Screening history</strong><p className="trust-lens-note">{history.slice(0, 3).map((item) => `${item.decision} · ${new Date(item.created_at).toLocaleString()}`).join("  |  ")}</p></div>}
                    </div>;
                  })()}
                  {trustLensOpen && !trustData && trustLensBusy && <div className="trust-lens-body"><p className="trust-lens-note">Loading sender evidence…</p></div>}
                </div>}
                {labels.length > 0 && (
                  <div className="detail-labels">
                    <span className="eyebrow">LABELS</span>
                    {labels.map((label) => (
                      <button
                        key={label.id}
                        className="label-chip"
                        onClick={() => void assignLabel(label.id)}
                        style={{ borderColor: label.color, color: label.color }}
                      >
                        <Tag size={12} /> {label.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="body-copy">
                  {selectedHtml ? <div className="email-html" dangerouslySetInnerHTML={{ __html: selectedHtml }} /> : selectedBody.body || "No message body."}
                </div>
                {selectedBody.quote && (
                  <details className="quoted-block">
                    <summary>Show quoted text</summary>
                    <div className="quoted-content">{selectedBody.quote}</div>
                  </details>
                )}
                {selected.attachments && selected.attachments.length > 0 && (
                  <div className="attachments">
                    <div className="attachments-head">
                      <p className="eyebrow">ATTACHMENTS · {selected.attachments.length}</p>
                      {selected.attachments.length > 1 && <button className="attachment-download-all" onClick={() => void downloadAllAttachments(selected.id)}><Download size={13} /> Download all</button>}
                    </div>
                    {selected.attachments.map((attachment) => (
                      <div className="attachment-card" key={attachment.id}>
                        <div className="attachment-card-main">
                          <Paperclip size={14} />
                          <span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.byte_size)} · {attachment.detected_content_type || attachment.content_type}</small></span>
                        </div>
                        <div className="attachment-card-actions">
                          {attachment.preview_state === "ready" && <button className="attachment-mini-action" onClick={() => void previewAttachment(attachment.id)}><Eye size={13} /> Preview</button>}
                          <button className="attachment-mini-action" onClick={() => void openAttachment(attachment.id)}><Download size={13} /> Download</button>
                        </div>
                        <small className={`attachment-safety attachment-safety-${attachment.safety_status || "unknown"}`}><ShieldAlert size={12} /> {attachment.safety_status === "suspicious" ? "Review before opening" : "Malware scan unavailable; static checks only"}</small>
                      </div>
                    ))}
                  </div>
                )}
                {threadMessages.length > 1 && (
                  <div className="conversation-section">
                    <div className="conversation-head">
                      <p className="eyebrow">CONVERSATION</p>
                      <span>{threadMessages.length} messages</span>
                    </div>
                    {!showAllThreadMessages && (
                      <button
                        className="thread-expand"
                        onClick={() => setShowAllThreadMessages(true)}
                      >
                        <ChevronDown size={15} /> Show {threadMessages.length - 1} earlier messages
                      </button>
                    )}
                    <div className="thread-stack">
                      {(showAllThreadMessages ? threadMessages : [selected]).map((threadMessage) => (
                        <button
                          key={threadMessage.id}
                          className={threadMessage.id === selected.id ? "active" : ""}
                          onClick={() => void openMessage(threadMessage)}
                        >
                          <span>{senderForMessage(threadMessage, contacts, mailboxes).name}</span>
                          <strong>{threadMessage.snippet || threadMessage.subject || "No preview available."}</strong>
                          <small>
                            {formatDate(threadMessage.received_at || threadMessage.sent_at || threadMessage.created_at)}
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="detail-actions">
                  {selected.direction === "outbound" && ["queued", "scheduled"].includes(selected.status) && !selected.cancelled_at ? (
                    <button className="secondary-button danger-button" onClick={() => void cancelSelectedSend()}>
                      <Undo2 size={15} /> Cancel send
                    </button>
                  ) : selected.folder === "trash" ? (
                    <>
                      <button
                        className="primary-button"
                        onClick={() => void restoreSelected()}
                        disabled={trashBusy}
                      >
                        <Undo2 size={15} /> Restore
                      </button>
                      <button
                        className="secondary-button danger-button"
                        onClick={() => void permanentlyDeleteSelected()}
                        disabled={trashBusy}
                      >
                        <Trash2 size={15} /> Delete forever
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="primary-button"
                        onClick={() => openCompose(selectedReplySeed)}
                      >
                        <PenLine size={15} /> Reply
                      </button>
                      <button
                        className="secondary-button detail-quick-action"
                        onClick={() => openCompose(selectedReplyAllSeed)}
                      >
                        <Users size={15} /> Reply all
                      </button>
                      <div className="more-actions">
                        <button
                          className="secondary-button"
                          aria-expanded={showMoreActions}
                          aria-haspopup="menu"
                          onClick={() => setShowMoreActions((current) => !current)}
                        >
                          <MoreHorizontal size={15} /> More
                        </button>
                        {showMoreActions && (
                          <div className="action-menu" role="menu">
                            <button role="menuitem" onClick={() => openCompose({ to: selected.to_addresses?.[0], subject: `Fwd: ${selected.subject}`, text: `\n\n— Forwarded message —\n${selected.text_body || selected.snippet}` })}>
                              <Forward size={15} /> Forward
                            </button>
                            <button role="menuitem" onClick={() => { setShowMoreActions(false); void toggleTrustLens(); }}>
                              <ShieldAlert size={15} /> {trustLensOpen ? "Hide trust details" : "Inspect trust details"}
                            </button>
                            <button role="menuitem" onClick={() => void mutateMessage({ isRead: false })}>
                              <Eye size={15} /> Mark unread
                            </button>
                            <button role="menuitem" onClick={() => void submitSpamFeedback(selected.folder === "spam" ? "not_spam" : "spam")}>
                              <ShieldAlert size={15} /> {selected.folder === "spam" ? "Not spam" : "Spam"}
                            </button>
                            <button role="menuitem" onClick={() => void mutateMessage({ snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() })}>
                              <Clock3 size={15} /> Snooze 1h
                            </button>
                            <button role="menuitem" onClick={() => void mutateMessage({ isFlagged: !selected.is_flagged })}>
                              <Flag size={15} /> {selected.is_flagged ? "Unflag" : "Flag"}
                            </button>
                            <button role="menuitem" onClick={() => void mutateMessage({ workState: "reply_later" })}>
                              <Clock3 size={15} /> Reply later
                            </button>
                            <button role="menuitem" onClick={() => void mutateMessage({ workState: "waiting_on" })}>
                              <Users size={15} /> Waiting on
                            </button>
                            <button role="menuitem" onClick={() => void mutateMessage({ workState: "i_owe" })}>
                              <Briefcase size={15} /> I owe
                            </button>
                            {selected.work_state && selected.work_state !== "none" && <button role="menuitem" onClick={() => void mutateMessage({ workState: "none" })}>
                              <Check size={15} /> Clear work state
                            </button>}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </article>
            )}
          </section>
        </>
      ) : (
        <Workspace
          mode={view}
          tasks={tasks}
          events={events}
          workItems={workItems}
          workSummary={workSummary}
          onOpenMessage={(message) => void openMessage(message)}
          onRefresh={() => {
            void loadWorkspace();
          }}
        />
      )}
      {composeOpen && (
        <Compose
          mailboxes={mailboxes}
          signatures={signatures}
          undoSeconds={settings.send_undo_seconds ?? 0}
          seed={composeSeed}
          onClose={() => {
            setComposeOpen(false);
            setComposeSeed(undefined);
          }}
          onSent={() => {
            void loadMessages("sent");
          }}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          session={session}
          settings={settings}
          folders={folders}
          labels={labels}
          mailboxes={mailboxes}
          rules={rules}
          senderPolicies={senderPolicies}
          onClose={() => setSettingsOpen(false)}
          onOpenMessage={(message) => void openMessage(message)}
          onChanged={() => {
            void loadMeta();
          }}
        />
      )}
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      setRecovering(hashParams.get("type") === "recovery");
      setReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === "PASSWORD_RECOVERY") setRecovering(true);
        if (event === "SIGNED_OUT") {
          setRecovering(false);
          setMfaRequired(false);
        }
        setSession(nextSession);
      },
    );
    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session || recovering || !supabase) {
      setMfaRequired(false);
      return;
    }
    let active = true;
    void supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data, error }) => {
      if (active && !error) setMfaRequired(data.currentLevel === "aal1" && data.nextLevel === "aal2");
    });
    return () => { active = false; };
  }, [session, recovering]);
  if (!ready)
    return (
      <div className="loading-screen">
        <div className="brand-mark">P</div>
        <p>Loading Parcel…</p>
      </div>
    );
  if (!supabase)
    return (
      <div className="loading-screen">
        <div className="brand-mark">P</div>
        <h2>Supabase is not configured</h2>
        <p>Add the public project URL and key to the deployment environment.</p>
      </div>
    );
  if (recovering) return <PasswordResetScreen onComplete={() => setRecovering(false)} />;
  if (!session) return <AuthScreen />;
  if (mfaRequired) return <MfaChallengeScreen onVerified={() => setMfaRequired(false)} />;
  return <MailboxApp session={session} />;
}
