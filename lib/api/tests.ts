import { fetchAllPages } from "@/lib/api/client";
import { singleFlight } from "@/lib/api/request-single-flight";
import { subscribeAuth } from "@/lib/auth-storage";
import type { ApiTest } from "@/lib/api/types";

const TESTS_CACHE_TTL_MS = 15_000;
let testsCache: { value: ApiTest[]; expiresAt: number } | null = null;
let authGen = 0;
// Kirish/chiqishda kesh boshqa foydalanuvchiga o'tmasin (ro'yxat bo'lim bo'yicha filtrlanadi)
subscribeAuth(() => { testsCache = null; authGen += 1; });

export function fetchTests(): Promise<ApiTest[]> {
  if (testsCache && testsCache.expiresAt > Date.now()) {
    return Promise.resolve(testsCache.value);
  }
  const gen = authGen;
  return singleFlight(`GET /api/tests/ #${gen}`, async () => {
    const list = await fetchAllPages<ApiTest>("/api/tests/");
    if (gen === authGen) testsCache = { value: list, expiresAt: Date.now() + TESTS_CACHE_TTL_MS };
    return list;
  });
}
