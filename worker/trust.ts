export type AuthStatus = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | string;

export type TrustAuthResults = {
  header: string;
  spf: AuthStatus | null;
  dkim: AuthStatus | null;
  dmarc: AuthStatus | null;
  arc: AuthStatus | null;
  tls: AuthStatus | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  dmarc_domain: string | null;
  tls_version: string | null;
  tls_cipher: string | null;
};

export type TrustLink = {
  host: string;
  count: number;
  shortened: boolean;
  suspicious: boolean;
};

export type TrustEvidence = {
  sender: string;
  reply_to: string;
  reply_to_mismatch: boolean;
  link_count: number;
  link_hosts: TrustLink[];
  tracking_pixel_count: number;
  tracking_pixel_hosts: string[];
  authentication: TrustAuthResults;
  first_seen_sender: boolean;
  known_contact: boolean;
  policy_action: string | null;
  policy_id: string | null;
};

export type TrustPolicy = {
  id: string;
  mailbox_id: string | null;
  match_type: "address" | "domain";
  match_value: string;
  action: string;
  target_folder_id?: string | null;
  target_label_id?: string | null;
  enabled?: boolean;
};

const statusPattern = "pass|fail|softfail|neutral|none|temperror|permerror";

function cleanAddress(value: string): string {
  return value.trim().replace(/^.*<([^>]+)>.*$/, "$1").toLowerCase();
}

function addressDomain(value: string): string {
  return cleanAddress(value).split("@").pop() || "";
}

function authStatus(header: string, mechanism: string): AuthStatus | null {
  const match = header.match(new RegExp("\\b" + mechanism + "=(\\w+)", "i"));
  if (!match) return null;
  const status = match[1].toLowerCase();
  return new RegExp("^(?:" + statusPattern + ")$", "i").test(status) ? status : "unknown";
}

function mechanismSegment(header: string, mechanism: string): string {
  return header.match(new RegExp("\\b" + mechanism + "=[^;]+", "i"))?.[0] || "";
}

function authParameter(header: string, mechanism: string, parameter: string): string | null {
  const segment = mechanismSegment(header, mechanism);
  const match = segment.match(new RegExp("\\b" + parameter + "=([^\\s;]+)", "i"));
  return match?.[1]?.replace(/[<>]/g, "").toLowerCase() || null;
}

function tlsStatus(header: string): AuthStatus | null {
  const explicit = authStatus(header, "tls");
  if (explicit) return explicit;
  return /\btls\.(?:version|cipher)=/i.test(header) ? "pass" : null;
}

export function normalizeAuthenticationResults(headers: Array<{ key?: string; value?: string }> = []): TrustAuthResults {
  const header = headers
    .filter((item) => String(item.key || "").toLowerCase() === "authentication-results")
    .map((item) => String(item.value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
  return {
    header,
    spf: authStatus(header, "spf"),
    dkim: authStatus(header, "dkim"),
    dmarc: authStatus(header, "dmarc"),
    arc: authStatus(header, "arc"),
    tls: tlsStatus(header),
    spf_domain: authParameter(header, "spf", "smtp.mailfrom"),
    dkim_domain: authParameter(header, "dkim", "header.d"),
    dmarc_domain: authParameter(header, "dmarc", "header.from"),
    tls_version: authParameter(header, "tls", "version") || header.match(/\btls\.version=([^\s;]+)/i)?.[1]?.toLowerCase() || null,
    tls_cipher: authParameter(header, "tls", "cipher") || header.match(/\btls\.cipher=([^\s;]+)/i)?.[1]?.toLowerCase() || null,
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");
}

function urlHost(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

function isSuspiciousHost(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith("xn--");
}

function isShortener(host: string): boolean {
  return /(?:^|\.)?(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly)$/i.test(host);
}

function attribute(tag: string, name: string): string {
  return tag.match(new RegExp("\\b" + name + "\\s*=\\s*[\"']?([^\\s\"'>]+)", "i"))?.[1] || "";
}

function isTinyDimension(value: string): boolean {
  const numeric = Number.parseFloat(value.replace(/px$/i, ""));
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 3;
}

export function extractTrustEvidence(input: {
  sender: string;
  replyTo?: string | null;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  authentication: TrustAuthResults;
  firstSeenSender?: boolean;
  knownContact?: boolean;
  policyAction?: string | null;
  policyId?: string | null;
}): TrustEvidence {
  const sender = cleanAddress(input.sender);
  const replyTo = cleanAddress(input.replyTo || sender);
  const html = String(input.htmlBody || "");
  const content = String(input.subject || "") + " " + String(input.textBody || "") + " " + stripHtml(html);
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*[\"'](https?:\/\/[^\"']+)[\"']/gi)].map((match) => match[1]);
  const urls = [...(content.match(/https?:\/\/[^\s"'<>]+/gi) || []), ...hrefs];
  const linkMap = new Map<string, TrustLink>();
  urls.forEach((value) => {
    const host = urlHost(value.replace(/[),.;!?]+$/, ""));
    if (!host) return;
    const current = linkMap.get(host);
    linkMap.set(host, {
      host,
      count: (current?.count || 0) + 1,
      shortened: Boolean(current?.shortened) || isShortener(host),
      suspicious: Boolean(current?.suspicious) || isSuspiciousHost(host),
    });
  });
  const linkHosts = [...linkMap.values()].slice(0, 50);
  const trackingPixelHosts = [...html.matchAll(/<img\b[^>]*>/gi)].flatMap((match) => {
    const tag = match[0];
    const src = attribute(tag, "src");
    if (!/^https?:\/\//i.test(src)) return [];
    const style = attribute(tag, "style");
    const tiny = isTinyDimension(attribute(tag, "width")) || isTinyDimension(attribute(tag, "height"))
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|width\s*:\s*[1-3]px|height\s*:\s*[1-3]px)/i.test(style);
    return tiny ? [urlHost(src)] : [];
  }).filter(Boolean).slice(0, 50);
  return {
    sender,
    reply_to: replyTo,
    reply_to_mismatch: Boolean(replyTo && sender && replyTo !== sender),
    link_count: urls.length,
    link_hosts: linkHosts,
    tracking_pixel_count: trackingPixelHosts.length,
    tracking_pixel_hosts: [...new Set(trackingPixelHosts)],
    authentication: input.authentication,
    first_seen_sender: input.firstSeenSender === true,
    known_contact: input.knownContact === true,
    policy_action: input.policyAction || null,
    policy_id: input.policyId || null,
  };
}

export function selectSenderPolicy(policies: TrustPolicy[], mailboxId: string, sender: string): TrustPolicy | null {
  const normalizedSender = cleanAddress(sender);
  const domain = addressDomain(normalizedSender);
  return policies
    .filter((policy) => policy.enabled !== false && (policy.mailbox_id === null || policy.mailbox_id === mailboxId))
    .filter((policy) => (policy.match_type === "address" && policy.match_value.toLowerCase() === normalizedSender)
      || (policy.match_type === "domain" && policy.match_value.toLowerCase().replace(/^@/, "").replace(/\.$/, "") === domain))
    .sort((left, right) => {
      const mailboxRank = Number(right.mailbox_id === mailboxId) - Number(left.mailbox_id === mailboxId);
      if (mailboxRank) return mailboxRank;
      const matchRank = Number(right.match_type === "address") - Number(left.match_type === "address");
      if (matchRank) return matchRank;
      const actionRank = (action: string) => action === "spam" ? 3 : action === "folder" || action === "archive" ? 2 : action === "screen" ? 1 : 0;
      return actionRank(right.action) - actionRank(left.action);
    })[0] || null;
}

export function authenticationAlignmentMismatches(auth: TrustAuthResults, visibleDomain: string): string[] {
  const mismatches: string[] = [];
  const align = (left: string | null, right: string) => Boolean(left && right && (left === right || left.endsWith("." + right) || right.endsWith("." + left)));
  if (auth.spf === "pass" && auth.spf_domain && !align(auth.spf_domain, visibleDomain)) mismatches.push("SPF");
  if (auth.dkim === "pass" && auth.dkim_domain && !align(auth.dkim_domain, visibleDomain)) mismatches.push("DKIM");
  if (auth.dmarc === "pass" && auth.dmarc_domain && !align(auth.dmarc_domain, visibleDomain)) mismatches.push("DMARC");
  return mismatches;
}

export function screeningDecisionPatch(decision: "approve" | "block" | "reroute", targetFolder?: "archive" | "custom"): { folder: string; custom_folder_id: string | null; screening_status: string; event: "allowed" | "blocked" | "rerouted" } {
  if (decision === "approve") return { folder: "inbox", custom_folder_id: null, screening_status: "approved", event: "allowed" };
  if (decision === "block") return { folder: "spam", custom_folder_id: null, screening_status: "blocked", event: "blocked" };
  return { folder: targetFolder === "custom" ? "custom" : "archive", custom_folder_id: null, screening_status: "rerouted", event: "rerouted" };
}
