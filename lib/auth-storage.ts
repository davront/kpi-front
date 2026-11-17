import type { ApiUser } from "@/lib/api/types";

const ACCESS = "asba_access";
const REFRESH = "asba_refresh";
const USER = "asba_user";
export const AUTH_CHANGE = "asba-auth-change";

function emitAuthChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_CHANGE));
  }
}

export function subscribeAuth(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AUTH_CHANGE, listener);
  return () => window.removeEventListener(AUTH_CHANGE, listener);
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(ACCESS);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(REFRESH);
}

export function getStoredUser(): ApiUser | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ApiUser;
  } catch {
    return null;
  }
}

export function getStoredUserFullName(): string | null {
  const user = getStoredUser();
  if (!user) return null;
  return user.full_name?.trim() || [user.first_name, user.last_name].filter(Boolean).join(" ") || null;
}

export function setSessionFromLogin(
  access: string,
  refresh: string,
  user: ApiUser,
): void {
  sessionStorage.setItem(ACCESS, access);
  sessionStorage.setItem(REFRESH, refresh);
  sessionStorage.setItem(USER, JSON.stringify(user));
  emitAuthChange();
}

export function setTokens(access: string, refresh?: string): void {
  sessionStorage.setItem(ACCESS, access);
  if (refresh) sessionStorage.setItem(REFRESH, refresh);
  emitAuthChange();
}

/** Urinish holati kalitlari (ActiveAttemptGuard, testlar sahifasi) — chiqishda keyingi foydalanuvchiga o'tmasin */
const ACTIVE_ATTEMPT = "active_attempt";
const ATTEMPT_BOOTSTRAP_PREFIX = "attempt_bootstrap_";

export function clearClientAuth(): void {
  sessionStorage.removeItem(ACCESS);
  sessionStorage.removeItem(REFRESH);
  sessionStorage.removeItem(USER);
  sessionStorage.removeItem(ACTIVE_ATTEMPT);
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const k = sessionStorage.key(i);
    if (k?.startsWith(ATTEMPT_BOOTSTRAP_PREFIX)) sessionStorage.removeItem(k);
  }
  emitAuthChange();
}

export function isClientAuthed(): boolean {
  return Boolean(getAccessToken());
}
