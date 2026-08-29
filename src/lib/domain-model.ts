export type DomainLifecycle =
  | "not_started"
  | "verification_pending"
  | "verified"
  | "configuration_required"
  | "active"
  | "error";

export type DnsRecordKind = "TXT" | "MX" | "CNAME" | "TXT_DKIM";

export type DnsInstruction = {
  kind: DnsRecordKind;
  host: string;
  value: string;
  purpose: string;
};

export type DomainRecord = {
  id: string;
  domain_name: string;
  verification_status: DomainLifecycle;
  receiving_status: DomainLifecycle;
  sending_status: DomainLifecycle;
  last_checked_at: string | null;
  dns_records: DnsInstruction[];
  user_message: string;
  technical_details?: string | null;
  source: "api" | "stub";
};

export type MailboxStatusView = {
  id: string;
  address: string;
  display_name: string;
  is_default: boolean;
  can_send: boolean;
  can_receive: boolean;
  status: DomainLifecycle;
  domain_name: string;
  disabled: boolean;
};

export type RawDomain = Partial<DomainRecord> & {
  domainName?: string;
  status?: string;
  lastCheckedAt?: string | null;
  dnsRecords?: DnsInstruction[];
  error?: string;
  last_error?: string;
};

export function normalizeDomainInput(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
}

export function isValidDomainName(value: string): boolean {
  const domain = normalizeDomainInput(value);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
    && domain.length <= 253
    && !domain.includes("..");
}

export function isValidLocalPart(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value.trim().toLowerCase());
}

export function domainStatusLabel(status: DomainLifecycle) {
  if (status === "not_started") return "Not started";
  if (status === "verification_pending") return "Verification pending";
  if (status === "verified") return "Verified";
  if (status === "configuration_required") return "Configuration required";
  if (status === "active") return "Active";
  return "Error";
}

export function domainStatusExplanation(status: DomainLifecycle) {
  if (status === "not_started") return "Add a domain you own to begin receiving and sending mail.";
  if (status === "verification_pending")
    return "Add the DNS record below, then check again. Ownership is not confirmed until the record matches.";
  if (status === "verified") return "Ownership is confirmed. Receiving and sending still need provider configuration.";
  if (status === "configuration_required")
    return "The domain is verified, but receiving or sending is not fully configured yet.";
  if (status === "active") return "This domain can receive and send mail through SulatHQ.";
  return "The last check did not succeed. Review the details and try again.";
}

export function onboardingSteps() {
  return [
    { id: "add", title: "Add your domain", why: "SulatHQ needs a domain you control before it can host addresses." },
    { id: "verify", title: "Verify ownership", why: "A DNS text record proves you control the domain." },
    { id: "receive", title: "Configure receiving", why: "Inbound mail is routed to SulatHQ only after receiving is configured." },
    { id: "send", title: "Configure sending", why: "Outbound mail is sent only after the sending identity is confirmed." },
    { id: "address", title: "Create an address", why: "An address is a mailbox on the verified domain, not a separate account." },
    { id: "inbox", title: "Open the inbox", why: "Once an address is active, new messages appear in Inbox." },
  ] as const;
}

export function currentOnboardingStep(domain: DomainRecord | null, mailboxCount: number) {
  if (!domain) return 0;
  if (domain.verification_status === "not_started" || domain.verification_status === "verification_pending" || domain.verification_status === "error")
    return 1;
  if (domain.receiving_status !== "active") return 2;
  if (domain.sending_status !== "active") return 3;
  if (mailboxCount < 1) return 4;
  return 5;
}

export function lifecycleFrom(value: unknown, fallback: DomainLifecycle): DomainLifecycle {
  const text = String(value || fallback);
  if (
    text === "not_started" ||
    text === "verification_pending" ||
    text === "verified" ||
    text === "configuration_required" ||
    text === "active" ||
    text === "error"
  )
    return text;
  if (text === "pending") return "verification_pending";
  if (text === "ready") return "active";
  return fallback;
}

export function defaultDnsRecords(domain: string): DnsInstruction[] {
  const host = domain || "example.com";
  return [
    {
      kind: "TXT",
      host: `_sulathq-verify.${host}`,
      value: "sulathq-site-verification=pending",
      purpose: "Prove you own this domain",
    },
    {
      kind: "MX",
      host: host,
      value: "inbound.sulathq.example (priority 10)",
      purpose: "Route inbound mail to SulatHQ",
    },
    {
      kind: "TXT",
      host: host,
      value: "v=spf1 include:spf.example.test ~all",
      purpose: "Authorize SulatHQ sending",
    },
    {
      kind: "TXT_DKIM",
      host: `sulathq._domainkey.${host}`,
      value: "v=DKIM1; k=rsa; p=pending",
      purpose: "Sign outbound mail",
    },
  ];
}

export function adaptDomain(raw: RawDomain, source: "api" | "stub"): DomainRecord {
  const name = String(raw.domain_name || raw.domainName || "").toLowerCase();
  const verification = lifecycleFrom(raw.verification_status || raw.status, "verification_pending");
  const receiving = lifecycleFrom(raw.receiving_status, verification === "active" ? "active" : "configuration_required");
  const sending = lifecycleFrom(raw.sending_status, receiving === "active" ? "active" : "configuration_required");
  return {
    id: String(raw.id || name || "pending"),
    domain_name: name,
    verification_status: verification,
    receiving_status: receiving,
    sending_status: sending,
    last_checked_at: raw.last_checked_at || raw.lastCheckedAt || null,
    dns_records: raw.dns_records || raw.dnsRecords || defaultDnsRecords(name),
    user_message: domainStatusExplanation(verification === "error" ? "error" : verification),
    technical_details: raw.technical_details || raw.last_error || raw.error || null,
    source,
  };
}

export function mailboxStatusView(mailbox: {
  id: string;
  address: string;
  display_name: string;
  is_default: boolean;
  can_send: boolean;
  can_receive?: boolean;
  status?: string;
}): MailboxStatusView {
  const domain_name = mailbox.address.split("@")[1] || "";
  const disabled = mailbox.status === "disabled" || mailbox.status === "inactive";
  let status: DomainLifecycle = "configuration_required";
  if (disabled) status = "not_started";
  else if (mailbox.status === "active" || (mailbox.can_send && mailbox.can_receive !== false)) status = "active";
  else if (mailbox.status === "error") status = "error";
  else if (mailbox.status === "verified") status = "verified";
  else if (mailbox.status === "pending") status = "verification_pending";
  if (!mailbox.can_send && mailbox.can_receive === false && !mailbox.status) status = "configuration_required";
  return {
    id: mailbox.id,
    address: mailbox.address,
    display_name: mailbox.display_name,
    is_default: mailbox.is_default,
    can_send: mailbox.can_send,
    can_receive: mailbox.can_receive !== false,
    status,
    domain_name,
    disabled,
  };
}

export function formatCheckedAt(value: string | null) {
  if (!value) return "Never checked";
  return `Last checked ${new Date(value).toLocaleString()}`;
}

export function mfaStatusLabel(verifiedCount: number, pending: boolean, setupOpen: boolean) {
  if (verifiedCount > 0) return "Two-step verification enabled";
  if (setupOpen) return "Setup started";
  if (pending) return "Setup started";
  return "Two-step verification off";
}
