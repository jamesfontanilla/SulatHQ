import type { DnsRecordInstruction } from "../../src/contracts/platform.ts";
import { sendingSpfRecord } from "./domain.ts";

export function isTemporaryProviderError(status: number): boolean {
  return status === 429 || status >= 500;
}

export function sendingRecordsFromBrevo(domainName: string, payload: Record<string, unknown>): DnsRecordInstruction[] {
  const records: DnsRecordInstruction[] = [sendingSpfRecord(domainName)];
  const dkim = payload.dkim_record || payload.dkim;
  if (dkim && typeof dkim === "object") {
    const row = dkim as Record<string, unknown>;
    records.push({
      purpose: "sending_dkim",
      type: String(row.type || "CNAME").toUpperCase() === "TXT" ? "TXT" : "CNAME",
      name: String(row.host || row.host_name || `mail._domainkey.${domainName}`),
      value: String(row.value || row.value_to_put || ""),
      ttlSeconds: 300,
      required: true,
    });
  } else {
    records.push({
      purpose: "sending_dkim",
      type: "CNAME",
      name: `mail._domainkey.${domainName}`,
      value: "mail.domainkey.brevo.com",
      ttlSeconds: 300,
      required: true,
    });
  }
  records.push({
    purpose: "sending_dmarc",
    type: "TXT",
    name: `_dmarc.${domainName}`,
    value: "v=DMARC1; p=none; rua=mailto:dmarc@sulathq.app",
    ttlSeconds: 300,
    required: false,
  });
  return records.filter((record) => record.value);
}
