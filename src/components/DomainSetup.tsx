import { FormEvent, useEffect, useState } from "react";
import { Check, Copy, RefreshCcw } from "lucide-react";
import {
  checkDomain,
  createDomain,
  currentOnboardingStep,
  DomainRecord,
  domainStatusExplanation,
  domainStatusLabel,
  formatCheckedAt,
  listDomains,
  onboardingSteps,
} from "../lib/domains";

export function DomainSetup({
  mailboxCount,
  compact = false,
  onOpenInbox,
}: {
  mailboxCount: number;
  compact?: boolean;
  onOpenInbox?: () => void;
}) {
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [stubbed, setStubbed] = useState(false);
  const [domainName, setDomainName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");
  async function refresh() {
    setError("");
    try {
      const result = await listDomains();
      setDomains(result.domains);
      setStubbed(result.stubbed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load domains");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await createDomain(domainName);
      setStubbed(result.stubbed);
      setDomains((current) => {
        if (current.some((item) => item.id === result.domain.id)) {
          return current.map((item) => (item.id === result.domain.id ? result.domain : item));
        }
        return [...current, result.domain];
      });
      setDomainName("");
      setNotice(result.stubbed ? "Domain saved in the setup preview until the platform API is available." : "Domain added. Add the DNS record, then check ownership.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not add that domain");
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await checkDomain(id);
      setStubbed(result.stubbed);
      setDomains((current) => current.map((item) => (item.id === id ? result.domain : item)));
      setNotice(result.stubbed ? "Checked the preview status. The platform still needs to confirm DNS." : "Verification checked.");
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Could not check this domain");
    } finally {
      setBusy(false);
    }
  }
  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("Could not copy to the clipboard");
    }
  }
  const selected = domains[0] || null;
  const stepIndex = currentOnboardingStep(selected, mailboxCount);
  const steps = onboardingSteps();
  return (
    <div className={`domain-setup${compact ? " compact" : ""}`}>
      {!compact && (
        <>
          <p className="eyebrow">DOMAIN SETUP</p>
          <h2>Add a domain you own</h2>
          <p className="domain-lead">
            SulatHQ hosts mail for domains you control. An address is not active until verification and configuration succeed.
          </p>
          <ol className="setup-steps">
            {steps.map((step, index) => (
              <li key={step.id} className={index === stepIndex ? "current" : index < stepIndex ? "done" : ""}>
                <span>{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <small>{step.why}</small>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {stubbed && (
        <div className="form-notice" role="status">
          Domain APIs are not available yet. This screen uses a typed preview so setup can be designed without changing backend contracts.
        </div>
      )}
      <form className="domain-add-form" onSubmit={(event) => void submit(event)}>
        <label>
          Domain name
          <input
            value={domainName}
            onChange={(event) => setDomainName(event.target.value)}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className="primary-button" disabled={busy || !domainName.trim()}>
          {busy ? "Working…" : "Add domain"}
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}
      {domains.length === 0 && (
        <div className="list-empty compact-empty">
          <h3>No domains yet</h3>
          <p>Start with a domain you already own. Do not add an address until ownership is verified.</p>
        </div>
      )}
      {domains.map((domain) => (
        <article className="domain-card" key={domain.id}>
          <div className="domain-card-head">
            <div>
              <strong>{domain.domain_name}</strong>
              <span className={`domain-status status-${domain.verification_status}`}>
                {domainStatusLabel(domain.verification_status)}
              </span>
            </div>
            <button className="secondary-button" onClick={() => void retry(domain.id)} disabled={busy}>
              <RefreshCcw size={14} /> Check again
            </button>
          </div>
          <p>{domain.user_message || domainStatusExplanation(domain.verification_status)}</p>
          <small className="field-help">{formatCheckedAt(domain.last_checked_at)}</small>
          <div className="domain-status-grid">
            <div>
              <span>Ownership</span>
              <strong>{domainStatusLabel(domain.verification_status)}</strong>
            </div>
            <div>
              <span>Receiving</span>
              <strong>{domainStatusLabel(domain.receiving_status)}</strong>
            </div>
            <div>
              <span>Sending</span>
              <strong>{domainStatusLabel(domain.sending_status)}</strong>
            </div>
          </div>
          <div className="dns-table" role="table" aria-label={`DNS records for ${domain.domain_name}`}>
            {domain.dns_records.map((record) => (
              <div className="dns-row" role="row" key={`${record.kind}-${record.host}-${record.purpose}`}>
                <div>
                  <span className="eyebrow">{record.kind}</span>
                  <strong>{record.host}</strong>
                  <small>{record.purpose}</small>
                </div>
                <code>{record.value}</code>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void copyValue(record.value)}
                  aria-label={`Copy ${record.kind} value`}
                >
                  {copied === record.value ? <Check size={14} /> : <Copy size={14} />} Copy
                </button>
              </div>
            ))}
          </div>
          {domain.technical_details && (
            <details>
              <summary>Technical details</summary>
              <pre>{domain.technical_details}</pre>
            </details>
          )}
          {stepIndex === 5 && onOpenInbox && (
            <button className="primary-button" onClick={onOpenInbox}>
              Open the inbox
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
