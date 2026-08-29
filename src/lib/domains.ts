import { apiFetch, isMissingRoute } from "./api";
import {
  adaptDomain,
  defaultDnsRecords,
  DomainRecord,
  isValidDomainName,
  normalizeDomainInput,
  RawDomain,
} from "./domain-model";

export * from "./domain-model";

let stubStore: DomainRecord[] = [];

export function resetDomainStubs() {
  stubStore = [];
}

export async function listDomains(): Promise<{ domains: DomainRecord[]; stubbed: boolean }> {
  try {
    const payload = await apiFetch<RawDomain[] | { items?: RawDomain[] }>("/api/domains");
    const rows = Array.isArray(payload) ? payload : payload.items || [];
    return { domains: rows.map((row) => adaptDomain(row, "api")), stubbed: false };
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
    return { domains: stubStore, stubbed: true };
  }
}

export async function createDomain(domainName: string): Promise<{ domain: DomainRecord; stubbed: boolean }> {
  const normalized = normalizeDomainInput(domainName);
  if (!isValidDomainName(normalized)) {
    throw new Error("Enter a domain you own, such as example.com");
  }
  try {
    const created = await apiFetch<RawDomain>("/api/domains", {
      method: "POST",
      body: JSON.stringify({ domainName: normalized }),
    });
    return { domain: adaptDomain(created, "api"), stubbed: false };
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
    const existing = stubStore.find((item) => item.domain_name === normalized);
    if (existing) return { domain: existing, stubbed: true };
    const domain = adaptDomain(
      {
        id: `stub-${normalized}`,
        domain_name: normalized,
        verification_status: "verification_pending",
        receiving_status: "not_started",
        sending_status: "not_started",
        last_checked_at: new Date().toISOString(),
        dns_records: defaultDnsRecords(normalized),
      },
      "stub",
    );
    stubStore = [...stubStore, domain];
    return { domain, stubbed: true };
  }
}

export async function checkDomain(id: string): Promise<{ domain: DomainRecord; stubbed: boolean }> {
  try {
    const checked = await apiFetch<RawDomain>(`/api/domains/${id}/verify`, { method: "POST" });
    return { domain: adaptDomain(checked, "api"), stubbed: false };
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
    const current = stubStore.find((item) => item.id === id);
    if (!current) throw new Error("Domain not found");
    const next: DomainRecord = {
      ...current,
      last_checked_at: new Date().toISOString(),
      user_message:
        "The platform has not published domain verification yet. The DNS values below are a preview for UI development.",
      technical_details: "GET/POST /api/domains is not available. Frontend is using a typed stub.",
    };
    stubStore = stubStore.map((item) => (item.id === id ? next : item));
    return { domain: next, stubbed: true };
  }
}
