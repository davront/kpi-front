"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  completeAttempt,
  fetchAttemptDetail,
  startAttempt,
  submitAnswer,
} from "@/lib/api/attempt-flow";
import { fetchTestDetail } from "@/lib/api/tests-crud";
import { useAttemptSessionEvents } from "@/lib/hooks/useAttemptSessionEvents";
import { useProctoring } from "@/lib/hooks/useProctoring";
import { getStoredUserFullName } from "@/lib/auth-storage";
import { setActiveAttempt, clearActiveAttempt, getActiveAttempt } from "@/components/ActiveAttemptGuard";
import type { ApiAttemptDetail, ApiTestDetail } from "@/lib/api/types";

function isFinishedAttemptError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("заверш") ||
    m.includes("completed") ||
    m.includes("already") ||
    m.includes("attempt")
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className ?? ""}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

function QuestionSkeleton() {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-8 w-8 animate-pulse rounded-lg bg-zinc-100"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
      <div className="space-y-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-100" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-100" style={{ animationDelay: "80ms" }} />
      </div>
      <div className="mt-5 space-y-2.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded-xl bg-zinc-100"
            style={{ animationDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
      <div className="mt-5 h-10 w-36 animate-pulse rounded-xl bg-zinc-100" />
    </div>
  );
}

export default function TestOtkazishPage() {
  const params = useParams();
  const router = useRouter();
  const rawId = params.id;
  const testId = Number(Array.isArray(rawId) ? rawId[0] : rawId);

  const [test, setTest] = useState<ApiTestDetail | null>(null);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [deadlineMs, setDeadlineMs] = useState<number | null>(null);
  const [, setVaqtTik] = useState(0);
  const deadlineRef = useRef<number | null>(null);
  deadlineRef.current = deadlineMs;

  const [timedOut, setTimedOut] = useState(false);
  const timedOutRef = useRef(false);
  timedOutRef.current = timedOut;
  const [yuklanmoqda, setYuklanmoqda] = useState(true);
  const [xato, setXato] = useState<string | null>(null);
  const [yakunlanganUrinishXatosi, setYakunlanganUrinishXatosi] = useState(false);
  const [tanlangan, setTanlangan] = useState<Record<number, number>>({});
  const [answeredIds, setAnsweredIds] = useState<number[]>([]);
  const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
  const [questionsTotal, setQuestionsTotal] = useState<number | null>(null);
  const [questionsAnswered, setQuestionsAnswered] = useState<number | null>(null);
  const [yuborilmoqda, setYuborilmoqda] = useState<number | null>(null);
  const [yakunlanmoqda, setYakunlanmoqda] = useState(false);
  const [yakunlashModal, setYakunlashModal] = useState(false);
  const [terminated, setTerminated] = useState(false);
  const skipFirstSyncRef = useRef(false);

  const { acquireCamera, start: startProctoring, stop: stopProctoring, stream, cameraStatus } = useProctoring();

  useEffect(() => {
    if (timedOut || terminated) stopProctoring();
  }, [timedOut, terminated, stopProctoring]);

  const { notification, dismissNotification } = useAttemptSessionEvents(attemptId, {
    active: Boolean(attemptId) && !timedOut && !yakunlanmoqda && !terminated,
    onTerminated: () => { clearActiveAttempt(); setTerminated(true); },
    onPageVisible: () => { if (attemptId) void syncAttemptMeta(attemptId); },
  });

  // Server tartibi (har urinish uchun aralashtirilgan) saqlanadi
  const savollar = useMemo(() => test?.questions ?? [], [test]);

  // Восстановить позицию: первый незаявленный вопрос после загрузки попытки
  const positionRestoredRef = useRef(false);
  useEffect(() => {
    if (positionRestoredRef.current) return;
    if (!attemptId || !savollar.length) return;
    positionRestoredRef.current = true;
    if (currentQuestionId != null) return; // уже установлен
    const answeredSet = new Set(answeredIds);
    const next = savollar.find((q) => !answeredSet.has(q.id));
    setCurrentQuestionId(next?.id ?? savollar[savollar.length - 1].id);
  }, [attemptId, savollar, answeredIds, currentQuestionId]);

  // Har bir javob saqlash boshida/oxirida oshadi: eski fon-sync yangi javobni bosib ketmasin
  const saqlashSeqRef = useRef(0);

  const applyAttemptSnapshot = useCallback((d: ApiAttemptDetail, { javoblarsiz = false } = {}) => {
    // deadline_at + server_time: qolgan vaqt server soati bo'yicha (mijoz soati noto'g'ri bo'lishi mumkin)
    const serverNow = d.server_time ? new Date(d.server_time).getTime() : NaN;
    const deadlineMs_ = d.deadline_at
      ? new Date(d.deadline_at).getTime() - (Number.isFinite(serverNow) ? serverNow : Date.now())
      : null;
    if (deadlineMs_ !== null && Number.isFinite(deadlineMs_)) {
      if (deadlineMs_ <= 0) {
        setDeadlineMs(null);
        setTimedOut(true);
      } else {
        setDeadlineMs(Date.now() + deadlineMs_);
      }
    } else if (typeof d.seconds_remaining === "number") {
      const sec = d.seconds_remaining;
      if (sec <= 0) {
        setDeadlineMs(null);
        setTimedOut(true);
      } else {
        setDeadlineMs(Date.now() + sec * 1000);
      }
    }
    if (typeof d.questions_total === "number") setQuestionsTotal(d.questions_total);
    if (typeof d.questions_answered === "number") setQuestionsAnswered(d.questions_answered);
    if (Array.isArray(d.answered_question_ids)) setAnsweredIds(d.answered_question_ids);
    if (!javoblarsiz && Array.isArray(d.responses)) {
      const map: Record<number, number> = {};
      for (const r of d.responses) {
        if (typeof r.question_id === "number" && typeof r.selected_option_id === "number") {
          map[r.question_id] = r.selected_option_id;
        }
      }
      if (Object.keys(map).length) setTanlangan((prev) => ({ ...prev, ...map }));
    }
  }, []);

  const syncAttemptMeta = useCallback(async (aid: number) => {
    try {
      const seq = saqlashSeqRef.current;
      const d = await fetchAttemptDetail(aid);
      applyAttemptSnapshot(d, { javoblarsiz: seq !== saqlashSeqRef.current });
      const st = String(d.status ?? "").toLowerCase();
      console.log("[syncAttemptMeta] status:", d.status);
      if (st.includes("terminat")) {
        clearActiveAttempt();
        setTerminated(true);
        return;
      }
      if (st.includes("complete") || st.includes("abandon") || st === "timed_out" || st === "done") {
        clearActiveAttempt();
        router.replace("/natijalar");
      }
    } catch (e) {
      console.log("[syncAttemptMeta] error:", e);
    }
  }, [applyAttemptSnapshot, router]);

  useEffect(() => {
    if (deadlineMs == null || timedOut) return;
    const id = setInterval(() => {
      setVaqtTik((n) => n + 1);
      const dl = deadlineRef.current;
      if (dl != null && Date.now() >= dl) setTimedOut(true);
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineMs, timedOut]);

  // Авто-complete когда таймер истёк
  useEffect(() => {
    if (!timedOut || !attemptId) return;
    stopProctoring();
    void completeAttempt(attemptId)
      .then(() => { clearActiveAttempt(); router.replace("/natijalar"); })
      .catch((err) => { console.warn("[timeout] completeAttempt failed:", err); clearActiveAttempt(); router.replace("/natijalar"); });
  }, [timedOut, attemptId, router, stopProctoring]);

  useEffect(() => {
    if (!Number.isFinite(testId) || testId <= 0) {
      setXato("Noto'g'ri test identifikatori.");
      setYuklanmoqda(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setYuklanmoqda(true);
      setXato(null);
      setYakunlanganUrinishXatosi(false);
      try {
        const t = await fetchTestDetail(testId);
        if (cancelled) return;
        setTest(t);
        const raw = sessionStorage.getItem(`attempt_bootstrap_${testId}`);
        if (raw) {
          sessionStorage.removeItem(`attempt_bootstrap_${testId}`);
          const att = JSON.parse(raw) as ApiAttemptDetail;
          if (att?.id) {
            skipFirstSyncRef.current = true;
            setAttemptId(att.id);
            applyAttemptSnapshot(att);
            setActiveAttempt({ attemptId: att.id, testId });
            void startProctoring(att.id);
          }
        } else {
          // Возврат на страницу теста после редиректа — bootstrap уже потреблён,
          // но active_attempt хранит attemptId активной попытки
          const active = getActiveAttempt();
          if (active && active.testId === testId) {
            try {
              const att = await fetchAttemptDetail(active.attemptId);
              if (!cancelled) {
                const st = String(att.status ?? "").toLowerCase();
                if (st.includes("in_progress") || st.includes("progress")) {
                  skipFirstSyncRef.current = true;
                  setAttemptId(att.id);
                  applyAttemptSnapshot(att);
                  void startProctoring(att.id);
                } else {
                  clearActiveAttempt();
                }
              }
            } catch (err) {
              console.warn("[bootstrap] fetchAttemptDetail failed:", err);
              if (!cancelled) clearActiveAttempt();
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "Testni yuklab yoki urinishni boshlab bo'lmadi.";
          setXato(msg);
          if (isFinishedAttemptError(msg)) setYakunlanganUrinishXatosi(true);
        }
      } finally {
        if (!cancelled) setYuklanmoqda(false);
      }
    })();
    return () => { cancelled = true; };
  }, [testId, syncAttemptMeta, applyAttemptSnapshot]);

  async function boshlash() {
    if (!Number.isFinite(testId) || testId <= 0) return;
    setXato(null);

    const cameraGranted = await acquireCamera();
    if (!cameraGranted) {
      setXato("Kameraga ruxsat berilmadi. Brauzerdagi ruxsat sozlamalarini tekshiring.");
      return;
    }

    setYuklanmoqda(true);
    try {
      const att = await startAttempt(testId);
      // Savollar urinish ketma-ketligi bo'yicha qayta yuklanadi
      setTest(await fetchTestDetail(testId));
      skipFirstSyncRef.current = true;
      setAttemptId(att.id);
      applyAttemptSnapshot(att);
      setActiveAttempt({ attemptId: att.id, testId });
      void startProctoring(att.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Urinishni boshlab bo'lmadi.";
      setXato(msg);
      if (isFinishedAttemptError(msg)) setYakunlanganUrinishXatosi(true);
    } finally {
      setYuklanmoqda(false);
    }
  }

  useEffect(() => {
    if (!attemptId || timedOut) return;
    let cancelled = false;
    const run = () => { if (!cancelled && !timedOutRef.current) void syncAttemptMeta(attemptId); };
    if (skipFirstSyncRef.current) {
      skipFirstSyncRef.current = false;
    } else {
      run();
    }
    const t = setInterval(run, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [attemptId, timedOut, syncAttemptMeta]);

  const [saqlashXatosi, setSaqlashXatosi] = useState<number | null>(null);

  // Javob tanlanganda darhol saqlanadi: vaqt tugasa ham yo'qolmaydi. Yakunlashgacha o'zgartirish mumkin.
  async function variantTanlash(savolId: number, variantId: number) {
    if (!attemptId || timedOut || yuklanmoqda || yuborilmoqda != null) return;
    const oldingi = tanlangan[savolId];
    setTanlangan((prev) => ({ ...prev, [savolId]: variantId }));
    setYuborilmoqda(savolId);
    setSaqlashXatosi(null);
    setXato(null);
    saqlashSeqRef.current += 1;
    try {
      const snap = await submitAnswer(attemptId, savolId, variantId);
      if (snap) applyAttemptSnapshot(snap);
    } catch (e) {
      setTanlangan((prev) => {
        const next = { ...prev };
        if (oldingi == null) delete next[savolId];
        else next[savolId] = oldingi;
        return next;
      });
      setSaqlashXatosi(savolId);
      setXato(e instanceof Error ? e.message : "Javobni saqlab bo'lmadi.");
      void syncAttemptMeta(attemptId);
    } finally {
      saqlashSeqRef.current += 1;
      setYuborilmoqda(null);
    }
  }

  function yakunlashniOchish() {
    setXato(null);
    setYakunlashModal(true);
  }

  const joriySavol = useMemo(() => {
    if (currentQuestionId != null) {
      const byId = savollar.find((q) => q.id === currentQuestionId);
      if (byId) return byId;
    }
    return savollar[0] ?? null;
  }, [currentQuestionId, savollar]);

  const joriyIdx = joriySavol ? savollar.findIndex((q) => q.id === joriySavol.id) : -1;
  const joriyTanlov = joriySavol == null ? null : tanlangan[joriySavol.id] ?? null;
  const javobsizlar = savollar
    .map((q, idx) => ({ id: q.id, raqam: idx + 1 }))
    .filter((q) => tanlangan[q.id] == null);

  function savolgaOtish(delta: number) {
    const q = savollar[joriyIdx + delta];
    if (q) setCurrentQuestionId(q.id);
  }

  async function yakunlash() {
    // Saqlanayotgan javob complete'dan oldin serverga yetib borishi shart
    if (!attemptId || timedOut || yuborilmoqda != null) return;
    setYakunlanmoqda(true);
    setXato(null);
    try {
      await completeAttempt(attemptId);
      stopProctoring();
      clearActiveAttempt();
      setYakunlashModal(false);
      router.replace("/natijalar");
    } catch (e) {
      setXato(e instanceof Error ? e.message : "Testni yakunlab bo'lmadi.");
    } finally {
      setYakunlanmoqda(false);
    }
  }

  const qolganSoniya =
    deadlineMs == null ? null : Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));

  const timerUrgency =
    qolganSoniya == null ? null
    : qolganSoniya < 60 ? "critical"
    : qolganSoniya < 300 ? "warning"
    : "ok";

  const timerClasses: Record<"ok" | "warning" | "critical", string> = {
    ok: "bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200",
    warning: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
    critical: "bg-red-600 text-white",
  };

  const answeredCount = questionsAnswered ?? answeredIds.length;
  const totalCount = questionsTotal ?? savollar.length;
  const progressPct = totalCount > 0 ? Math.min(100, Math.round((answeredCount / totalCount) * 100)) : 0;

  const userFullName = useMemo(() => getStoredUserFullName(), []);

  if (!Number.isFinite(testId) || testId <= 0) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4">
        <p className="text-sm text-red-800">{xato ?? "Noto'g'ri manzil."}</p>
        <Link href="/testlar" className="mt-2 inline-block text-sm font-medium text-emerald-800 hover:underline">
          ← Testlar ro&apos;yxatiga qaytish
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-24 sm:pb-0">
      {/* ─── Header ─── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {!attemptId ? (
          <Link
            href="/testlar"
            className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 transition hover:text-emerald-900"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
            Testlar
          </Link>
          ) : null}
          <h2 className="mt-1.5 text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl">
            {yuklanmoqda && !test ? (
              <span className="inline-block h-7 w-56 animate-pulse rounded-lg bg-zinc-200" aria-hidden />
            ) : (
              test?.title ?? "Test"
            )}
          </h2>
          {test?.description ? (
            <p className="mt-1 text-sm leading-relaxed text-zinc-500">{test.description}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {qolganSoniya != null && qolganSoniya > 0 && !timedOut ? (
            <span
              role="timer"
              aria-label="Qolgan vaqt"
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-base font-semibold tabular-nums transition-colors duration-700 ${timerClasses[timerUrgency!]}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0" aria-hidden>
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clipRule="evenodd" />
              </svg>
              <span className="text-xs font-medium opacity-80">Qolgan vaqt</span>
              {Math.floor(qolganSoniya / 60)}:{String(qolganSoniya % 60).padStart(2, "0")}
            </span>
          ) : null}
          <p className="sr-only" aria-live="assertive">
            {qolganSoniya === 300 ? "5 daqiqa qoldi" : qolganSoniya === 60 ? "1 daqiqa qoldi" : ""}
          </p>
        </div>
      </div>

      {/* ─── Progress bar ─── */}
      {attemptId && totalCount > 0 && !yuklanmoqda ? (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-500">Javob berilgan</span>
            <span className="tabular-nums font-semibold text-zinc-700">
              {answeredCount} / {totalCount}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-zinc-500">
            Yakunlashdan oldin istalgan savolga qaytib, javobni o&apos;zgartirishingiz mumkin.
          </p>
        </div>
      ) : null}

      {/* ─── Warning banner ─── */}
      {attemptId && !timedOut && !yakunlanmoqda ? (
        <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden>
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          <p className="text-amber-900">
            <span className="font-semibold">Diqqat:</span>{" "}
            test davomida boshqa yorliqqa yoki ilovaga o&apos;tish natijangizga ta&apos;sir qiladi.
          </p>
        </div>
      ) : null}

      {/* ─── Timed out ─── */}
      {timedOut ? (
        <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden>
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clipRule="evenodd" />
          </svg>
          <p className="text-red-900" role="status">
            Vaqt tugadi. Saqlangan javoblaringiz yuborilmoqda…
          </p>
        </div>
      ) : null}

      {/* ─── Error ─── */}
      {xato ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p>{xato}</p>
          {yakunlanganUrinishXatosi ? (
            <button
              type="button"
              onClick={() => router.push("/natijalar")}
              className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-900 transition hover:bg-red-50"
            >
              Natijalarni ochish
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ─── Main content ─── */}
      {yuklanmoqda ? (
        <QuestionSkeleton />
      ) : !test ? null : !attemptId ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7 text-emerald-700" aria-hidden>
              <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
            </svg>
          </div>
          {userFullName ? (
            <p className="mb-1 text-sm font-medium text-zinc-500">
              {userFullName},{" "}
              <span className="text-zinc-700">siz</span>
            </p>
          ) : null}
          <h3 className="text-lg font-semibold text-zinc-900">
            &ldquo;{test.title}&rdquo; testini boshlashga tayyormisiz?
          </h3>
          <p className="mt-1.5 text-sm text-zinc-500">
            &quot;Boshlash&quot; tugmasini bossangiz, vaqt hisobi boshlanadi.
          </p>
          <button
            type="button"
            onClick={() => void boshlash()}
            disabled={yuklanmoqda || cameraStatus === "pending"}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-8 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-900/15 transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            {cameraStatus === "pending" ? (
              <>
                <Spinner className="h-4 w-4" />
                Kamera ruxsati kutilmoqda…
              </>
            ) : yuklanmoqda ? (
              <>
                <Spinner className="h-4 w-4" />
                Boshlanmoqda…
              </>
            ) : (
              "Boshlash"
            )}
          </button>
        </div>
      ) : savollar.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm">
          <p className="text-sm text-zinc-500">Bu testda savollar yo&apos;q.</p>
        </div>
      ) : (
        <>
          {joriySavol ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
              {/* Question nav */}
              <div className="mb-2 flex flex-wrap gap-1.5">
                {savollar.map((q, idx) => {
                  const selected = tanlangan[q.id];
                  const active = joriySavol.id === q.id;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setCurrentQuestionId(q.id)}
                      aria-label={`${idx + 1}-savol${selected != null ? " (javob berilgan)" : ""}`}
                      aria-current={active ? "step" : undefined}
                      className={`h-10 min-w-10 rounded-lg px-2 text-xs font-semibold transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 sm:h-8 sm:min-w-8 ${
                        active
                          ? "bg-emerald-700 text-white shadow-sm"
                          : selected != null
                            ? "bg-white text-emerald-800 ring-1 ring-inset ring-emerald-600 hover:bg-emerald-50"
                            : "bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-200 hover:text-zinc-900"
                      }`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>
              <p className="mb-5 text-xs text-zinc-500">Yashil chiziqli — javob berilgan</p>

              {/* Question text */}
              <p className="text-sm font-medium text-zinc-500">
                Savol {joriyIdx + 1} / {savollar.length}
              </p>
              <h3 id="savol-matn" className="mt-1 text-lg font-semibold leading-snug text-zinc-900 sm:text-xl">
                {joriySavol.text}
              </h3>

              {/* Options */}
              <fieldset className="mt-4 space-y-2" aria-labelledby="savol-matn">
                {joriySavol.options.map((opt) => {
                  const disabled = timedOut || !attemptId;
                  return (
                    <label
                      key={opt.id}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 px-4 py-3.5 text-[15px] text-zinc-700 transition-colors duration-150 hover:border-emerald-300 hover:bg-zinc-50 has-[:checked]:border-emerald-600 has-[:checked]:bg-emerald-50 has-[:checked]:font-medium has-[:checked]:text-emerald-950 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-emerald-700 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                    >
                      <input
                        type="radio"
                        name={`savol-${joriySavol.id}`}
                        checked={joriyTanlov === opt.id}
                        disabled={disabled}
                        onChange={() => void variantTanlash(joriySavol.id, opt.id)}
                        className="mt-1 h-4 w-4 shrink-0 accent-emerald-700"
                      />
                      <span>{opt.text}</span>
                    </label>
                  );
                })}
              </fieldset>
              <p className="mt-2 min-h-5 text-sm" aria-live="polite">
                {yuborilmoqda === joriySavol.id ? (
                  <span className="text-zinc-500">Saqlanmoqda…</span>
                ) : saqlashXatosi === joriySavol.id ? (
                  <span className="text-red-700">Saqlanmadi — qayta tanlang</span>
                ) : joriyTanlov != null ? (
                  <span className="text-emerald-700">Javob saqlandi</span>
                ) : null}
              </p>

              {/* Navigation */}
              <div className="mt-6 flex items-center justify-between gap-3 border-t border-zinc-100 pt-5">
                <button
                  type="button"
                  onClick={() => savolgaOtish(-1)}
                  disabled={joriyIdx <= 0}
                  className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Oldingi savol
                </button>
                {joriyIdx < savollar.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => savolgaOtish(1)}
                    className="rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-900/15 transition hover:bg-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                  >
                    Keyingi savol
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={yakunlashniOchish}
                    disabled={timedOut || !attemptId || yuborilmoqda != null}
                    className="rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-900/15 transition hover:bg-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Javoblarni ko&apos;rib chiqish
                  </button>
                )}
              </div>
            </div>
          ) : null}

          {/* Submit section */}
          <div className="rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-zinc-800">Testni yakunlash</p>
                <p className={`mt-0.5 text-xs ${javobsizlar.length ? "text-zinc-500" : "font-medium text-emerald-700"}`}>
                  {javobsizlar.length
                    ? `${javobsizlar.length} ta savolga javob berilmagan`
                    : "Barcha savollarga javob berilgan"}
                </p>
              </div>
              <button
                type="button"
                disabled={timedOut || yakunlanmoqda || !attemptId || yuborilmoqda != null}
                onClick={yakunlashniOchish}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-900/15 transition hover:bg-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Testni yakunlash
              </button>
            </div>
          </div>
        </>
      )}

      {/* ─── Notification modal ─── */}
      {notification ? (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 backdrop-blur-[2px]"
        >
          <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-amber-200 bg-white px-6 py-7 text-center shadow-2xl">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 text-amber-500" aria-hidden>
                <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.598 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-zinc-900">
                {notification.eventType === "page_visible"
                  ? "Boshqa yorliqqa o'tildi"
                  : "Boshqa ilova ochildi"}
              </p>
              <p className="mt-1.5 text-sm text-zinc-500">{notification.message}</p>
            </div>
            <button
              type="button"
              onClick={dismissNotification}
              className="w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
            >
              Tushunarli
            </button>
          </div>
        </div>
      ) : null}

      {/* ─── Terminated modal ─── */}
      {terminated ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 p-4 backdrop-blur-[2px]"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="terminated-title"
        >
          <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border border-red-100 bg-white px-6 py-8 text-center shadow-2xl">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-8 w-8 text-red-500" aria-hidden>
                <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.72 6.97a.75.75 0 10-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 101.06 1.06L12 13.06l1.72 1.72a.75.75 0 101.06-1.06L13.06 12l1.72-1.72a.75.75 0 10-1.06-1.06L12 10.94l-1.72-1.72z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <p id="terminated-title" className="text-xl font-bold tracking-tight text-zinc-900">
                Test to&apos;xtatildi
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                Boshqa yorliq yoki ilova ochilganligi sababli urinish avtomatik yakunlandi.
                Ball hisoblanmaydi.
              </p>
            </div>
            <button
              type="button"
              onClick={() => router.replace("/natijalar")}
              className="w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-700"
            >
              Natijalarni ko&apos;rish
            </button>
          </div>
        </div>
      ) : null}

      {/* ─── Finish modal ─── */}
      {yakunlashModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="yakunlash-modal-title"
          onKeyDown={(e) => { if (e.key === "Escape" && !yakunlanmoqda) setYakunlashModal(false); }}
        >
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <h3 id="yakunlash-modal-title" className="text-lg font-semibold text-zinc-900">
              Testni yakunlaysizmi?
            </h3>
            <p className="mt-2 text-sm text-zinc-600">
              Javob berilgan:{" "}
              <span className="font-semibold tabular-nums text-zinc-900">
                {savollar.length - javobsizlar.length} / {savollar.length}
              </span>
            </p>
            {javobsizlar.length ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-900">Javob berilmagan savollar:</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {javobsizlar.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => { setCurrentQuestionId(q.id); setYakunlashModal(false); }}
                      className="h-9 min-w-9 rounded-lg bg-white px-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-300 transition hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
                    >
                      {q.raqam}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="mt-3 text-sm text-zinc-500">
              Yakunlangandan keyin javoblarni o&apos;zgartirib bo&apos;lmaydi.
            </p>
            {xato ? <p role="alert" className="mt-2 text-sm text-red-700">{xato}</p> : null}
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                autoFocus
                disabled={yakunlanmoqda}
                onClick={() => setYakunlashModal(false)}
                className="flex-1 rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50"
              >
                Testga qaytish
              </button>
              <button
                type="button"
                disabled={yakunlanmoqda || timedOut || yuborilmoqda != null}
                onClick={() => void yakunlash()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-900/15 transition hover:bg-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {yakunlanmoqda ? (
                  <>
                    <Spinner className="h-3.5 w-3.5 text-white" />
                    Yakunlanmoqda…
                  </>
                ) : (
                  "Ha, yakunlash"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <CameraPreview stream={stream} />
    </div>
  );
}

function CameraPreview({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
      el.play().catch(() => {});
    } else {
      el.srcObject = null;
    }
  }, [stream]);

  if (!stream) return null;

  return (
    <div className="fixed bottom-3 right-3 z-20 overflow-hidden rounded-xl shadow-lg ring-1 ring-zinc-900/10 sm:bottom-4 sm:right-4">
      <video
        ref={videoRef}
        muted
        playsInline
        className="h-20 w-28 object-cover bg-zinc-900 sm:h-28 sm:w-40"
        aria-label="Kamera ko'rinishi"
      />
      <span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-zinc-900/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
        Kamera
      </span>
    </div>
  );
}
