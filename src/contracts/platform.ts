/**
 * Shared SulatHQ platform contracts.
 *
 * Frontend should consume these types and error codes rather than provider
 * payloads. Existing Worker field names are preserved; this file documents
 * the self-service surface added alongside owner-scoped APIs.
 *
 * New fields on existing resources are additive. Deprecated: treating
 * `OWNER_USER_ID` as the only valid inbound mailbox owner.
 */

export const PLATFORM_ERROR_CODES = [
  "DOMAIN_NOT_VERIFIED",
  "DOMAIN_CONFIGURATION_PENDING",
  "MAILBOX_NOT_ACTIVE",
  "RECIPIENT_INVALID",
  "ATTACHMENT_TOO_LARGE",
  "SEND_RATE_LIMITED",
  "DRAFT_CONFLICT",
  "PROVIDER_TEMPORARY_FAILURE",
  "DOMAIN_INVALID",
  "DOMAIN_ALREADY_EXISTS",
  "DNS_MISMATCH",
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "MFA_PENDING",
  "MFA_EXPIRED",
  "MFA_INVALID_CODE",
] as const;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

export type DomainVerificationStatus = "pending" | "verified" | "failed";
export type DomainReceivingStatus = "not_started" | "configuration_required" | "active" | "error";
export type DomainSendingStatus = "not_started" | "pending_dns" | "active" | "error";
export type MailboxStatus = "pending" | "active" | "disabled";
export type MfaSetupStatus = "not_started" | "pending_verification" | "enabled" | "cancelled" | "expired";

export type DnsRecordInstruction = {
  purpose: "ownership" | "receiving_mx" | "sending_spf" | "sending_dkim" | "sending_dmarc";
  type: "TXT" | "MX" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  ttlSeconds: number;
  required: boolean;
};

export type Organization = {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  created_at: string;
};

export type Domain = {
  id: string;
  organization_id: string;
  domain_name: string;
  verification_status: DomainVerificationStatus;
  receiving_status: DomainReceivingStatus;
  sending_status: DomainSendingStatus;
  provider_reference: string | null;
  last_checked_at: string | null;
  verified_at: string | null;
  cloudflare_dns_required: boolean;
  dns_records: DnsRecordInstruction[];
  created_at: string;
  updated_at: string;
};

export type Mailbox = {
  id: string;
  organization_id: string | null;
  domain_id: string | null;
  local_part: string | null;
  address: string;
  display_name: string;
  status: MailboxStatus;
  is_default: boolean;
  can_send: boolean;
  can_receive: boolean;
  created_at: string;
  updated_at?: string;
};

export type PlatformErrorBody = {
  error: string;
  code: PlatformErrorCode;
  details?: Record<string, unknown>;
};

export type MailboxEvent = {
  event_type: "message.created" | "message.updated" | "domain.updated";
  message_id?: string;
  mailbox_id?: string;
  thread_id?: string;
  folder?: string;
  timestamp: string;
  preview?: { subject?: string; snippet?: string };
};

export type MfaSetup = {
  status: MfaSetupStatus;
  factor_id: string | null;
  friendly_name: string | null;
  qr_code?: string;
  secret?: string;
  uri?: string;
  expires_at: string | null;
};

export type SessionSummary = {
  id: string;
  current: boolean;
  user_agent: string | null;
  ip: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SendMessageInput = {
  fromAddress: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  messageIdHeader?: string;
  idempotencyKey?: string;
  attachments?: Array<{ filename: string; contentType?: string; url?: string; contentBase64?: string }>;
};

export type SendMessageResult = {
  providerMessageId?: string;
  accepted: boolean;
  temporaryFailure?: boolean;
};

export type VerifyDomainInput = {
  domainName: string;
};

export type ProviderStatus = {
  provider: "brevo" | "cloudflare";
  domainName: string;
  authenticated: boolean;
  dnsRecords: DnsRecordInstruction[];
  providerReference: string | null;
  error?: string;
};

export type DeliveryStatus = "queued" | "sent" | "delivered" | "bounced" | "failed" | "unknown";

export interface MailTransport {
  send(input: SendMessageInput): Promise<SendMessageResult>;
  verifyDomain(input: VerifyDomainInput): Promise<ProviderStatus>;
  getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatus>;
}
