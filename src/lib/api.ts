import { requireSupabase } from "./supabase";

export class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;
  constructor(message: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(
      `SulatHQ returned an unexpected response (${response.status}). Please try again.`,
      response.status,
      {},
    );
  }
  return response.json().catch(() => ({}));
}

function payloadError(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const message = (payload as { error?: unknown }).error;
  return typeof message === "string" ? message : undefined;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = (await requireSupabase().auth.getSession()).data.session;
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok)
    throw new ApiError(payloadError(payload) || `Request failed (${response.status})`, response.status, (payload as Record<string, unknown>) ?? {});
  return payload as T;
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const session = (await requireSupabase().auth.getSession()).data.session;
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(path, {
    method: "POST",
    body: form,
    headers: session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {},
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payloadError(payload) || `Upload failed (${response.status})`);
  return payload as T;
}

export async function publicApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payloadError(payload) || `Request failed (${response.status})`);
  return payload as T;
}

export function isMissingRoute(error: unknown) {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}
