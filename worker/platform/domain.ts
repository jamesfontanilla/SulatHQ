import type { DnsRecordInstruction } from "../../src/contracts/platform.ts";
import { PlatformError } from "./errors.ts";

export function normalizeDomainName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").replace(/^https?:\/\//, "").split("/")[0];
}

export function isValidDomainName(value: string): boolean {
  const domain = normalizeDomainName(value);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
    && domain.length <= 253
    && !domain.includes("..");
}

export function parseDomainOrThrow(value: string): string {
  const domain = normalizeDomainName(value);
  if (!isValidDomainName(domain)) throw new PlatformError("DOMAIN_INVALID", "Enter a valid domain such as example.com");
  return domain;
}

export function normalizeLocalPart(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidLocalPart(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(normalizeLocalPart(value));
}

export function fullAddress(localPart: string, domainName: string): string {
  return `${normalizeLocalPart(localPart)}@${normalizeDomainName(domainName)}`;
}

export function ownershipTxtName(domainName: string): string {
  return `_sulathq-verify.${normalizeDomainName(domainName)}`;
}

export function ownershipTxtValue(token: string): string {
  return `sulathq-verify=${token}`;
}

export function normalizeTxt(value: string): string {
  return value.trim().replace(/^"+|"+$/g, "").replace(/\s+/g, " ").toLowerCase();
}

export function txtValuesMatch(observed: string[], expected: string): boolean {
  const wanted = normalizeTxt(expected);
  return observed.some((value) => normalizeTxt(value) === wanted || normalizeTxt(value).includes(wanted));
}

export function generateVerificationToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ownershipDnsRecord(domainName: string, token: string): DnsRecordInstruction {
  return {
    purpose: "ownership",
    type: "TXT",
    name: ownershipTxtName(domainName),
    value: ownershipTxtValue(token),
    ttlSeconds: 60,
    required: true,
  };
}

export function receivingMxRecords(domainName: string): DnsRecordInstruction[] {
  const domain = normalizeDomainName(domainName);
  return [
    { purpose: "receiving_mx", type: "MX", name: domain, value: "route1.mx.cloudflare.net", priority: 10, ttlSeconds: 300, required: true },
    { purpose: "receiving_mx", type: "MX", name: domain, value: "route2.mx.cloudflare.net", priority: 20, ttlSeconds: 300, required: true },
    { purpose: "receiving_mx", type: "MX", name: domain, value: "route3.mx.cloudflare.net", priority: 30, ttlSeconds: 300, required: true },
  ];
}

export function sendingSpfRecord(domainName: string): DnsRecordInstruction {
  return {
    purpose: "sending_spf",
    type: "TXT",
    name: normalizeDomainName(domainName),
    value: "v=spf1 include:spf.brevo.com ~all",
    ttlSeconds: 300,
    required: true,
  };
}

export function cloudflareMxConfigured(mxHosts: string[]): boolean {
  return mxHosts.some((host) => /(^|\.)mx\.cloudflare\.net$/i.test(host.replace(/\.$/, "")));
}

export type DnsLookup = (name: string, type: "TXT" | "MX") => Promise<string[]>;

export async function lookupTxtDoH(name: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
  const response = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
  if (!response.ok) throw new PlatformError("PROVIDER_TEMPORARY_FAILURE", "DNS lookup failed", 503);
  const body = await response.json() as { Answer?: Array<{ data?: string }> };
  return (body.Answer || []).map((answer) => String(answer.data || "")).filter(Boolean);
}

export async function lookupMxDoH(name: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`;
  const response = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
  if (!response.ok) throw new PlatformError("PROVIDER_TEMPORARY_FAILURE", "DNS lookup failed", 503);
  const body = await response.json() as { Answer?: Array<{ data?: string }> };
  return (body.Answer || []).map((answer) => String(answer.data || "").replace(/^\d+\s+/, "").replace(/\.$/, "")).filter(Boolean);
}
