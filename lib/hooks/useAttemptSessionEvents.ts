"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postAttemptSessionEvent } from "@/lib/api/attempt-flow";
import type { AttemptSessionEventPayload } from "@/lib/api/types";

type Options = {
  /** false — urinish tugagan yoki taymer tugagan */
  active: boolean;
  /** server attempt_terminated: true qaytarganida chaqiriladi */
  onTerminated?: () => void;
  /** foydalanuvchi boshqa yorliqdan qaytganida chaqiriladi */
  onPageVisible?: () => void;
  /**
   * Kamera/ekran ishlamay qoldi: null → qiymat o'tishida shu hodisa yuboriladi (chiqish kabi).
   * camera_off → screen_off almashinuvi — o'sha bitta holat, qayta yuborilmaydi.
   */
  proctorOff?: ProctorOffEvent | null;
  /** true — window_blur yuborilmaydi (kamera/ekran oynasi ochiq: qulf belgisi, ulashish oynasi) */
  ignoreBlur?: boolean;
  /** Qoidabuzarlik hodisasi yuborilganda (surat olish uchun) */
  onViolation?: (eventType: ViolationEvent) => void;
};

type ProctorOffEvent = "camera_off" | "screen_off";
type ViolationEvent = "page_hidden" | "window_blur" | "devtools" | ProctorOffEvent;

/** F12, Ctrl/Cmd+Shift+I/J/C, Cmd+Option+I/J/C, Ctrl/Cmd+U (manba kodi). e.code — Option tugmasi harfni o'zgartiradi. */
function isDevtoolsShortcut(e: KeyboardEvent): boolean {
  if (e.key === "F12") return true;
  const mod = e.ctrlKey || e.metaKey;
  if ((mod && e.shiftKey) || (e.metaKey && e.altKey)) return ["KeyI", "KeyJ", "KeyC"].includes(e.code);
  return mod && e.code === "KeyU";
}

/** Birinchi chiqish uchun ogohlantirish — faqat tugma bilan yopiladi */
export type SessionNotification = {
  eventType: ViolationEvent;
};

const BLUR_DEFER_MS = 100;
const FOCUS_SKIP_AFTER_VISIBLE_MS = 200;

/**
 * Tab / oyna fokusi o’zgarishida POST /api/attempts/<id>/session-events/
 * (bir harakatda visibility + blur/focus dublikatlarini kamaytirish)
 */
export function useAttemptSessionEvents(
  attemptId: number | null,
  { active, onTerminated, onPageVisible, proctorOff = null, ignoreBlur = false, onViolation }: Options,
): { notification: SessionNotification | null; dismissNotification: () => void } {
  const leaveCountRef = useRef(0);
  const tabHiddenAtRef = useRef<number | null>(null);
  const pageVisibleSentAtRef = useRef(0);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminatedRef = useRef(false);
  const onTerminatedRef = useRef(onTerminated);
  const onPageVisibleRef = useRef(onPageVisible);
  const onViolationRef = useRef(onViolation);
  const ignoreBlurRef = useRef(ignoreBlur);
  const prevProctorOffRef = useRef(proctorOff);
  useEffect(() => {
    onTerminatedRef.current = onTerminated;
    onPageVisibleRef.current = onPageVisible;
    onViolationRef.current = onViolation;
    ignoreBlurRef.current = ignoreBlur;
  });

  const [notification, setNotification] = useState<SessionNotification | null>(null);

  const dismissNotification = useCallback(() => setNotification(null), []);

  useEffect(() => {
    if (!attemptId || !active) return;

    leaveCountRef.current = 0;
    tabHiddenAtRef.current = null;
    pageVisibleSentAtRef.current = 0;
    terminatedRef.current = false;

    const send = (
      payload: Omit<AttemptSessionEventPayload, "client_timestamp">,
      opts: { keepalive?: boolean } = {},
    ) =>
      postAttemptSessionEvent(
        attemptId,
        { ...payload, client_timestamp: new Date().toISOString() },
        opts,
      );

    const handleTerminated = () => {
      if (terminatedRef.current) return;
      terminatedRef.current = true;
      setNotification(null);
      onTerminatedRef.current?.();
    };

    const onVisibilityChange = () => {
      if (blurTimerRef.current != null) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }

      if (document.visibilityState === "hidden") {
        if (terminatedRef.current) return;
        // Sahifa yangilanmoqda/yopilmoqda yoki shu yorliqda boshqa saytga o'tilmoqda:
        // urinish to'xtatilmaydi, lekin kurator ko'rishi uchun page_unload qayd etiladi.
        if (unloadingRef.current) {
          void send({
            event_type: "page_unload",
            leave_count: leaveCountRef.current,
            duration_away_ms: null,
            meta: { visibilityState: document.visibilityState },
          }, { keepalive: true });
          return;
        }
        leaveCountRef.current += 1;
        tabHiddenAtRef.current = Date.now();
        onViolationRef.current?.("page_hidden");
        void send({
          event_type: "page_hidden",
          leave_count: leaveCountRef.current,
          duration_away_ms: null,
          meta: { visibilityState: document.visibilityState },
        }, { keepalive: true }).then((result) => {
          if (result.terminated) handleTerminated();
          else if (result.warning) setNotification({ eventType: "page_hidden" });
        });
      } else {
        if (terminatedRef.current) {
          handleTerminated();
          return;
        }
        const awayMs =
          tabHiddenAtRef.current != null
            ? Date.now() - tabHiddenAtRef.current
            : null;
        tabHiddenAtRef.current = null;
        pageVisibleSentAtRef.current = Date.now();
        void send({
          event_type: "page_visible",
          leave_count: leaveCountRef.current,
          duration_away_ms: awayMs,
          meta: { visibilityState: document.visibilityState },
        });
        onPageVisibleRef.current?.();
      }
    };

    const onWindowBlur = () => {
      if (blurTimerRef.current != null) clearTimeout(blurTimerRef.current);
      blurTimerRef.current = setTimeout(() => {
        blurTimerRef.current = null;
        if (document.visibilityState !== "visible") return;
        if (terminatedRef.current || ignoreBlurRef.current) return;

        leaveCountRef.current += 1;
        onViolationRef.current?.("window_blur");
        void send({
          event_type: "window_blur",
          leave_count: leaveCountRef.current,
          duration_away_ms: null,
          meta: { visibilityState: document.visibilityState },
        }).then((result) => {
          if (result.terminated) handleTerminated();
          else if (result.warning) setNotification({ eventType: "window_blur" });
        });
      }, BLUR_DEFER_MS);
    };

    const onWindowFocus = () => {
      if (focusTimerRef.current != null) clearTimeout(focusTimerRef.current);
      focusTimerRef.current = setTimeout(() => {
        focusTimerRef.current = null;
        if (document.visibilityState !== "visible") return;
        if (terminatedRef.current) return;
        if (Date.now() - pageVisibleSentAtRef.current < FOCUS_SKIP_AFTER_VISIBLE_MS) return;
        void send({
          event_type: "window_focus",
          leave_count: leaveCountRef.current,
          duration_away_ms: null,
          meta: { visibilityState: document.visibilityState },
        });
      }, BLUR_DEFER_MS);
    };

    // Yangilash/yopishda beforeunload va pagehide visibilitychange(hidden) dan oldin keladi.
    // beforeunload bekor bo'lishi mumkin (yuklab olish, mailto:) — bayroq 1 s dan keyin o'chadi;
    // pageshow — bfcache'dan qaytganda.
    const unloadingRef = { current: false };
    let unloadResetTimer: ReturnType<typeof setTimeout> | null = null;
    const onBeforeUnload = () => {
      unloadingRef.current = true;
      if (unloadResetTimer != null) clearTimeout(unloadResetTimer);
      unloadResetTimer = setTimeout(() => { unloadingRef.current = false; }, 1000);
    };
    const onPageHide = () => { unloadingRef.current = true; };
    const onPageShow = () => { unloadingRef.current = false; };

    // DevTools: tugmalar bloklanadi va qoidabuzarlik hisoblanadi. Menyu orqali ochish — window_blur.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isDevtoolsShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || terminatedRef.current) return;
      onViolationRef.current?.("devtools");
      void send({
        event_type: "devtools",
        leave_count: leaveCountRef.current,
        duration_away_ms: null,
        meta: { key: e.key, code: e.code },
      }).then((result) => {
        if (result.terminated) handleTerminated();
        else if (result.warning) setNotification({ eventType: "devtools" });
      });
    };
    // O'ng tugma menyusidagi "Kodni ko'rish" (Inspect) yopiladi
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("contextmenu", onContextMenu);

    return () => {
      if (blurTimerRef.current != null) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
      if (focusTimerRef.current != null) { clearTimeout(focusTimerRef.current); focusTimerRef.current = null; }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      if (unloadResetTimer != null) clearTimeout(unloadResetTimer);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [attemptId, active]);

  useEffect(() => {
    const rising = proctorOff && !prevProctorOffRef.current;
    prevProctorOffRef.current = proctorOff;
    if (!rising || !attemptId || !active || terminatedRef.current) return;
    onViolationRef.current?.(proctorOff);
    void postAttemptSessionEvent(attemptId, {
      event_type: proctorOff,
      leave_count: null,
      duration_away_ms: null,
      meta: {},
    }).then((result) => {
      if (terminatedRef.current) return;
      if (result.terminated) {
        terminatedRef.current = true;
        setNotification(null);
        onTerminatedRef.current?.();
      } else if (result.warning) {
        setNotification({ eventType: proctorOff });
      }
    });
  }, [proctorOff, attemptId, active]);

  return { notification, dismissNotification };
}
