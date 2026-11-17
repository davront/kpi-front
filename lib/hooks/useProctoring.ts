"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/config";
import { getAccessToken } from "@/lib/auth-storage";
import { postAttemptSnapshot } from "@/lib/api/attempt-flow";

/** denied — ruxsat yo'q; unavailable — kamera topilmadi/band; lost — test paytida o'chdi */
export type CameraStatus = "idle" | "pending" | "granted" | "denied" | "unavailable" | "lost";
/** wrong — butun ekran emas, oyna/yorliq tanlandi; unsupported — brauzer (telefon) ulasha olmaydi */
export type ScreenStatus = "idle" | "pending" | "granted" | "denied" | "wrong" | "lost" | "unsupported";

export function screenCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);
}

/** Video kadrini JPEG Blob'ga: maxW gacha kichraytiriladi */
function grabFrame(video: HTMLVideoElement | null, maxW: number, quality: number): Promise<Blob | null> {
  if (!video || !video.videoWidth) return Promise.resolve(null);
  const scale = Math.min(1, maxW / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

const RECONNECT_MAX_MS = 15000;
/** Server: urinish tugagan — qayta ulanish befoyda */
const WS_CLOSE_EXPIRED = 4408;

export function useProctoring() {
  const wsRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const [screenStatus, setScreenStatus] = useState<ScreenStatus>("idle");
  /** teardown() har chaqirilganda oshadi — kechikkan await'lar eski ishga tegishli ekanini bilish uchun */
  const runRef = useRef(0);

  const teardown = useCallback((status: CameraStatus) => {
    runRef.current += 1;
    if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (reconnectRef.current !== null) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
    wsRef.current?.close();
    wsRef.current = null;
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setCameraStatus(status);
  }, []);

  const releaseScreen = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    if (screenVideoRef.current) { screenVideoRef.current.srcObject = null; screenVideoRef.current = null; }
  }, []);

  const stop = useCallback(() => {
    teardown("idle");
    releaseScreen();
    setScreenStatus("idle");
  }, [teardown, releaseScreen]);

  /** Butun ekranni ulashish. Faqat foydalanuvchi bosishidan chaqirilsin (brauzer talabi). */
  const acquireScreen = useCallback(async (): Promise<boolean> => {
    if (screenStreamRef.current) return true;
    if (!screenCaptureSupported()) { setScreenStatus("unsupported"); return false; }
    setScreenStatus("pending");
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, audio: false });
      const track = s.getVideoTracks()[0];
      // displaySurface'ni bermaydigan brauzerlarda tekshiruv o'tkazib yuboriladi
      const surface = (track?.getSettings() as { displaySurface?: string }).displaySurface;
      if (!track || (surface && surface !== "monitor")) {
        s.getTracks().forEach((t) => t.stop());
        setScreenStatus("wrong");
        return false;
      }
      const video = document.createElement("video");
      video.srcObject = s;
      video.muted = true;
      await video.play().catch(() => {});
      screenStreamRef.current = s;
      screenVideoRef.current = video;
      // Brauzerning "Ulashishni to'xtatish" tugmasi
      track.addEventListener("ended", () => {
        if (screenStreamRef.current !== s) return;
        releaseScreen();
        setScreenStatus("lost");
      }, { once: true });
      setScreenStatus("granted");
      return true;
    } catch (err) {
      console.warn("[proctoring] screen error:", err);
      setScreenStatus("denied");
      return false;
    }
  }, [releaseScreen]);

  /** Kamera va ekran suratini serverga (davriy yoki qoidabuzarlikda). Xatolar yutiladi. */
  const snapshot = useCallback(async (attemptId: number, reason: string) => {
    const [camera, screen] = await Promise.all([
      grabFrame(videoRef.current, 640, 0.7),
      grabFrame(screenVideoRef.current, 1280, 0.5),
    ]);
    if (camera) void postAttemptSnapshot(attemptId, "camera", reason, camera);
    if (screen) void postAttemptSnapshot(attemptId, "screen", reason, screen);
  }, []);

  const acquireCamera = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    const run = runRef.current;
    setCameraStatus("pending");
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (run !== runRef.current) {
        // kutish paytida stop() chaqirildi — kamera yonib qolmasin
        mediaStream.getTracks().forEach((t) => t.stop());
        return false;
      }
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setCameraStatus("granted");
      return true;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setCameraStatus(name === "NotAllowedError" ? "denied" : "unavailable");
      console.warn("[proctoring] camera error:", err);
      return false;
    }
  }, []);

  const start = useCallback(async (attemptId: number): Promise<void> => {
    if (!getAccessToken()) { console.warn("[proctoring] no auth token"); return; }
    if (videoRef.current) return; // allaqachon ishga tushgan
    const run = runRef.current;

    if (!streamRef.current) {
      const ok = await acquireCamera();
      if (!ok || run !== runRef.current) return;
    }
    const mediaStream = streamRef.current;
    if (!mediaStream) return;

    const video = document.createElement("video");
    video.srcObject = mediaStream;
    video.muted = true;
    await video.play().catch((err) => { console.warn("[proctoring] video.play failed:", err); });
    if (run !== runRef.current || videoRef.current) { video.srcObject = null; return; }
    videoRef.current = video;

    // Kamera uzildi / ruxsat qaytarib olindi — test bloklanadi (sahifa "lost" ni ko'rsatadi)
    mediaStream.getVideoTracks().forEach((t) =>
      t.addEventListener("ended", () => { if (run === runRef.current) teardown("lost"); }, { once: true }),
    );

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d")!;

    const origin = new URL(apiUrl("/"));
    const protocol = origin.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${origin.host}/ws/proctoring/${attemptId}/?role=streamer`;
    let retry = 0;

    const connect = () => {
      reconnectRef.current = null;
      if (run !== runRef.current) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let timer: ReturnType<typeof setInterval> | null = null;

      ws.onopen = () => {
        retry = 0;
        // Token URL'da emas, birinchi xabarda: access-loglarga tushmasin. Har ulanishda yangisi olinadi.
        ws.send(JSON.stringify({ type: "auth", token: getAccessToken() ?? "" }));
        timer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          ws.send(JSON.stringify({ type: "frame", data: canvas.toDataURL("image/jpeg", 0.4) }));
        }, 200);
        intervalRef.current = timer;
      };

      ws.onclose = (e) => {
        if (timer !== null) clearInterval(timer);
        if (intervalRef.current === timer) intervalRef.current = null;
        if (wsRef.current === ws) wsRef.current = null;
        if (run !== runRef.current || e.code === WS_CLOSE_EXPIRED) return;
        // Tarmoq uzilishi: 1s, 2s, 4s … 15s gacha kutib qayta ulanamiz
        const delay = Math.min(1000 * 2 ** retry, RECONNECT_MAX_MS);
        retry += 1;
        reconnectRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (err) => { console.warn("[proctoring] ws error:", err); ws.close(); };
    };

    connect();
  }, [acquireCamera, teardown]);

  // Sahifadan chiqilganda (unmount) kamera, WS va interval o'chsin
  useEffect(() => stop, [stop]);

  return { acquireCamera, acquireScreen, start, stop, snapshot, stream, cameraStatus, screenStatus };
}
