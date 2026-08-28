import type { DeliveryStatus, DnsRecordInstruction, MailTransport, ProviderStatus, SendMessageInput, SendMessageResult, VerifyDomainInput } from "../../src/contracts/platform.ts";
import { PlatformError } from "./errors.ts";
import { isTemporaryProviderError, sendingRecordsFromBrevo } from "./brevo-status.ts";

export type BrevoClient = {
  apiKey: string;
  fetch: typeof fetch;
  signAttachment?: (objectKey: string) => Promise<string>;
};

export function brevoTransport(client: BrevoClient): MailTransport {
  return {
    async send(input: SendMessageInput): Promise<SendMessageResult> {
      const payload: Record<string, unknown> = {
        sender: { email: input.fromAddress },
        to: input.to.map((email) => ({ email })),
        subject: input.subject || "(no subject)",
        textContent: input.text || "",
        htmlContent: input.html || undefined,
        replyTo: { email: input.replyTo || input.fromAddress },
        headers: {
          ...(input.messageIdHeader ? { "Message-ID": input.messageIdHeader } : {}),
          ...(input.inReplyTo ? { "In-Reply-To": input.inReplyTo } : {}),
          ...(input.references ? { References: input.references } : {}),
        },
      };
      if (input.cc?.length) payload.cc = input.cc.map((email) => ({ email }));
      if (input.bcc?.length) payload.bcc = input.bcc.map((email) => ({ email }));
      if (input.attachments?.length) {
        payload.attachment = await Promise.all(input.attachments.map(async (attachment) => {
          if (attachment.contentBase64) return { name: attachment.filename, content: attachment.contentBase64 };
          if (attachment.url) return { name: attachment.filename, url: attachment.url };
          throw new PlatformError("VALIDATION_FAILED", "Attachment is missing a signed URL");
        }));
      }
      const response = await client.fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "api-key": client.apiKey,
          "content-type": "application/json",
          ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({})) as { messageId?: string; message?: string };
      if (!response.ok) {
        if (isTemporaryProviderError(response.status)) {
          throw new PlatformError("PROVIDER_TEMPORARY_FAILURE", "The sending provider is temporarily unavailable", 503);
        }
        throw new PlatformError("VALIDATION_FAILED", "The sending provider rejected this message", response.status >= 400 ? response.status : 502);
      }
      return { providerMessageId: result.messageId, accepted: true };
    },

    async verifyDomain(input: VerifyDomainInput): Promise<ProviderStatus> {
      const domainName = input.domainName.toLowerCase();
      const created = await upsertBrevoDomain(client, domainName);
      return created;
    },

    async getDeliveryStatus(_providerMessageId: string): Promise<DeliveryStatus> {
      return "unknown";
    },
  };
}

async function upsertBrevoDomain(client: BrevoClient, domainName: string): Promise<ProviderStatus> {
  const list = await client.fetch("https://api.brevo.com/v3/senders/domains", {
    headers: { accept: "application/json", "api-key": client.apiKey },
  });
  if (list.status === 404 || list.status === 405) {
    return {
      provider: "brevo",
      domainName,
      authenticated: false,
      dnsRecords: sendingRecordsFromBrevo(domainName, {}),
      providerReference: null,
    };
  }
  if (!list.ok && list.status !== 409) {
    if (isTemporaryProviderError(list.status)) {
      throw new PlatformError("PROVIDER_TEMPORARY_FAILURE", "Could not reach the sending provider", 503);
    }
  }
  const existing = list.ok ? await list.json().catch(() => ({})) as { domains?: Array<{ domain_name?: string; authenticated?: boolean; dns_records?: unknown }> } : {};
  const match = (existing.domains || []).find((row) => String(row.domain_name || "").toLowerCase() === domainName);
  if (!match) {
    await client.fetch("https://api.brevo.com/v3/senders/domains", {
      method: "POST",
      headers: { accept: "application/json", "api-key": client.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ domain: domainName }),
    }).catch(() => undefined);
  }
  const detail = await client.fetch(`https://api.brevo.com/v3/senders/domains/${encodeURIComponent(domainName)}`, {
    headers: { accept: "application/json", "api-key": client.apiKey },
  });
  const body = detail.ok ? await detail.json().catch(() => ({})) as Record<string, unknown> : {};
  const authenticated = body.authenticated === true || body.verified === true;
  return {
    provider: "brevo",
    domainName,
    authenticated,
    dnsRecords: sendingRecordsFromBrevo(domainName, body),
    providerReference: typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : domainName,
  };
}

export { sendingRecordsFromBrevo };
