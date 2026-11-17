import { localizeApiMessage } from "@/lib/api/localize-api-message";
import type { ApiErrorBody, TokenRefreshResponse } from "@/lib/api/types";
import {
  clearClientAuth,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from "@/lib/auth-storage";

/** rejected — refresh token yaroqsiz (400/401); error — tarmoq/5xx, tokenlar saqlanadi */
type RefreshResult = "ok" | "rejected" | "error";

let refreshInFlight: Promise<RefreshResult> | null = null;
const getInFlight = new Map<string, Promise<Response>>();

const proxyUrl = (path: string) => `/api/proxy${path.startsWith("/") ? path : `/${path}`}`;

function buildGetRequestKey(url: string, headers: Headers): string {
  return `GET ${url} :: auth=${headers.get("Authorization") ?? ""} :: accept=${headers.get("Accept") ?? ""}`;
}

async function fetchWithGetDedup(url: string, init: RequestInit): Promise<Response> {
  const method = String(init.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    return fetch(url, init);
  }

  const headers = new Headers(init.headers);
  const key = buildGetRequestKey(url, headers);
  const existing = getInFlight.get(key);
  if (existing) {
    return (await existing).clone();
  }

  const request = fetch(url, init).finally(() => {
    getInFlight.delete(key);
  });
  getInFlight.set(key, request);
  return (await request).clone();
}

async function postRefresh(): Promise<RefreshResult> {
  const refresh = getRefreshToken();
  if (!refresh) return "rejected";
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch("/api/proxy/api/auth/refresh/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh }),
      });
      if (res.status === 400 || res.status === 401) return "rejected";
      if (!res.ok) return "error";
      const data = (await res.json()) as TokenRefreshResponse;
      if (!data.access) return "error";
      setTokens(data.access, data.refresh);
      return "ok";
    } catch {
      return "error";
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export type ApiFetchOptions = RequestInit & {
  /** default: true for mutating methods */
  auth?: boolean;
  /** ichki: qayta urinishdan oldin refresh qilinmasin */
  _skipRefresh?: boolean;
};

export async function apiFetch(
  path: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  const { auth = true, _skipRefresh, headers: initHeaders, ...rest } = options;
  const headers = new Headers(initHeaders);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  if (auth && !headers.has("Authorization")) {
    const access = getAccessToken();
    if (access) headers.set("Authorization", `Bearer ${access}`);
  }

  if (
    rest.body &&
    typeof rest.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  let res = await fetchWithGetDedup(proxyUrl(path), { ...rest, headers });

  if (res.status === 401 && auth && !_skipRefresh) {
    const result = await postRefresh();
    if (result === "ok") {
      const retryHeaders = new Headers(headers);
      const newAccess = getAccessToken();
      if (newAccess) retryHeaders.set("Authorization", `Bearer ${newAccess}`);
      res = await fetchWithGetDedup(proxyUrl(path), {
        ...rest,
        headers: retryHeaders,
      });
    } else if (result === "rejected") {
      clearClientAuth();
    }
    // "error": vaqtinchalik nosozlik — tokenlarni o'chirmaymiz, asl 401 javobini qaytaramiz
  }

  return res;
}

export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return res.statusText || "Xatolik";
  try {
    const j = JSON.parse(text) as ApiErrorBody;
    if (typeof j.detail === "string") {
      return localizeApiMessage(j.detail);
    }
    if (Array.isArray(j.non_field_errors) && j.non_field_errors[0]) {
      return localizeApiMessage(String(j.non_field_errors[0]));
    }
    const firstKey = Object.keys(j).find(
      (k) => k !== "detail" && Array.isArray(j[k]),
    );
    if (firstKey) {
      const arr = j[firstKey] as unknown;
      if (Array.isArray(arr) && arr[0]) {
        return localizeApiMessage(String(arr[0]));
      }
    }
    return text;
  } catch {
    return text;
  }
}

/** GET ro'yxat: DRF `next` bo'yicha barcha sahifalarni yig'adi. */
// ponytail: hamma sahifa ketma-ket yuklanadi; ro'yxat juda katta bo'lsa — UI pagination.
export async function fetchAllPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = path;
  while (next) {
    const res = await apiFetch(next, { method: "GET" });
    if (!res.ok) throw new Error(await readApiError(res));
    const data: unknown = await res.json();
    items.push(...unwrapList<T>(data));
    const nextUrl = (data as { next?: string | null } | null)?.next;
    if (nextUrl) {
      // Django sub-path ostida bo'lsa ham proxy uchun /api/... dan boshlanadi
      const u = new URL(nextUrl);
      next = `${u.pathname.slice(Math.max(0, u.pathname.indexOf("/api/")))}${u.search}`;
    } else {
      next = null;
    }
  }
  return items;
}

export function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (
    data &&
    typeof data === "object" &&
    "results" in data &&
    Array.isArray((data as { results: T[] }).results)
  ) {
    return (data as { results: T[] }).results;
  }
  return [];
}
