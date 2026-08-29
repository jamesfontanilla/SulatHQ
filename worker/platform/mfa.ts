import type { MfaSetupStatus } from "../../src/contracts/platform.ts";

export const MFA_PENDING_TTL_MS = 30 * 60 * 1000;
export const MFA_FRIENDLY_NAME = "SulatHQ authenticator";

export type MfaFactor = {
  id: string;
  friendly_name?: string | null;
  factor_type?: string;
  status: string;
  created_at?: string;
};

export type MfaPlan = {
  status: MfaSetupStatus;
  reusePendingId: string | null;
  revokePendingIds: string[];
  enroll: boolean;
  expiresAt: string | null;
};

export function isPendingExpired(createdAt: string | undefined, now: number, ttlMs = MFA_PENDING_TTL_MS): boolean {
  if (!createdAt) return true;
  const time = Date.parse(createdAt);
  return !Number.isFinite(time) || now - time > ttlMs;
}

export function planMfaStart(input: {
  verified: MfaFactor[];
  unverified: MfaFactor[];
  now?: number;
  restart: boolean;
}): MfaPlan {
  const now = input.now ?? Date.now();
  if (input.verified.length) {
    return { status: "enabled", reusePendingId: null, revokePendingIds: [], enroll: false, expiresAt: null };
  }
  const livePending = input.unverified.filter((factor) => !isPendingExpired(factor.created_at, now));
  const expired = input.unverified.filter((factor) => isPendingExpired(factor.created_at, now));
  if (!input.restart && livePending[0]) {
    return {
      status: "pending_verification",
      reusePendingId: livePending[0].id,
      revokePendingIds: [...expired, ...livePending.slice(1)].map((factor) => factor.id),
      enroll: false,
      expiresAt: new Date(now + MFA_PENDING_TTL_MS).toISOString(),
    };
  }
  return {
    status: "pending_verification",
    reusePendingId: null,
    revokePendingIds: input.unverified.map((factor) => factor.id),
    enroll: true,
    expiresAt: new Date(now + MFA_PENDING_TTL_MS).toISOString(),
  };
}

export function mfaStatusFromFactors(verifiedCount: number, pendingCount: number, pendingExpired: boolean): MfaSetupStatus {
  if (verifiedCount > 0) return "enabled";
  if (pendingCount > 0 && pendingExpired) return "expired";
  if (pendingCount > 0) return "pending_verification";
  return "not_started";
}
