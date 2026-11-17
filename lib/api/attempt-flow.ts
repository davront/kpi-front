import { apiFetch, readApiError } from "@/lib/api/client";
import { singleFlight } from "@/lib/api/request-single-flight";
import type {
  ApiAttemptDetail,
  AttemptSessionEventPayload,
  AttemptSessionEventResponse,
} from "@/lib/api/types";

/** POST /api/tests/<id>/attempts/ */
export async function startAttempt(testId: number): Promise<ApiAttemptDetail> {
  const res = await apiFetch(`/api/tests/${testId}/attempts/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as ApiAttemptDetail;
}

/** GET /api/attempts/<id>/ */
export function fetchAttemptDetail(id: number): Promise<ApiAttemptDetail> {
  return singleFlight(`GET /api/attempts/${id}/`, async () => {
    const res = await apiFetch(`/api/attempts/${id}/`, { method: "GET" });
    if (!res.ok) throw new Error(await readApiError(res));
    return (await res.json()) as ApiAttemptDetail;
  });
}

/** POST /api/attempts/<id>/answer/ */
export async function submitAnswer(
  attemptId: number,
  question_id: number,
  option_id: number,
): Promise<ApiAttemptDetail | undefined> {
  const res = await apiFetch(`/api/attempts/${attemptId}/answer/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id, option_id }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  const ct = res.headers.get("content-type");
  if (ct?.includes("application/json")) return (await res.json()) as ApiAttemptDetail;
  return undefined;
}

export async function completeAttempt(attemptId: number): Promise<void> {
  const res = await apiFetch(`/api/attempts/${attemptId}/complete/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await readApiError(res));
}

export async function abandonAttempt(attemptId: number): Promise<void> {
  const res = await apiFetch(`/api/attempts/${attemptId}/abandon/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await readApiError(res));
}

/** POST /api/attempts/<id>/events/ — telemetriya; attempt_terminated ni qaytarishi mumkin */
/** POST /api/attempts/<id>/snapshots/ — JPEG, multipart. Xato bo'lsa jim (test to'xtamasin). */
export async function postAttemptSnapshot(
  attemptId: number,
  kind: "camera" | "screen",
  reason: string,
  image: Blob,
): Promise<void> {
  const body = new FormData();
  body.append("kind", kind);
  body.append("reason", reason);
  body.append("image", image, `${kind}.jpg`);
  try {
    await apiFetch(`/api/attempts/${attemptId}/snapshots/`, { method: "POST", body });
  } catch (err) {
    console.warn("[snapshot] upload failed:", err);
  }
}

export async function postAttemptSessionEvent(
  attemptId: number,
  body: AttemptSessionEventPayload,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<{ terminated: boolean; warning: boolean }> {
  try {
    const res = await apiFetch(`/api/attempts/${attemptId}/events/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        client_timestamp:
          body.client_timestamp ?? new Date().toISOString(),
      }),
      keepalive,
    });
    console.log("[postAttemptSessionEvent] status:", res.status, "url:", res.url);
    if (!res.ok) return { terminated: false, warning: false };
    const ct = res.headers.get("content-type");
    if (ct?.includes("application/json")) {
      const data = (await res.json()) as AttemptSessionEventResponse;
      console.log("[postAttemptSessionEvent] response body:", data);
      return { terminated: Boolean(data?.attempt_terminated), warning: Boolean(data?.warning) };
    }
    return { terminated: false, warning: false };
  } catch {
    return { terminated: false, warning: false };
  }
}
