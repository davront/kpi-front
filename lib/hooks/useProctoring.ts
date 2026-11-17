"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/config";
import { getAccessToken } from "@/lib/auth-storage";

export type CameraStatus = "idle" | "pending" | "granted" | "denied";

export function useProctoring() {
  const wsRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  /** stop() har chaqirilganda oshadi — kechikkan await'lar eski ishga tegishli ekanini bilish uchun */
  const runRef = useRef(0);

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
      setCameraStatus(name === "NotAllowedError" ? "denied" : "idle");
      console.warn("[proctoring] camera error:", err);
      return false;
    }
  }, []);

  const start = useCallback(async (attemptId: number): Promise<void> => {
    const token = getAccessToken();
    if (!token) { console.warn("[proctoring] no auth token"); return; }
    if (wsRef.current) return; // allaqachon ishga tushgan
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
    if (run !== runRef.current || wsRef.current) { video.srcObject = null; return; }
    videoRef.current = video;

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d")!;

    const origin = new URL(apiUrl("/"));
    const protocol = origin.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${origin.host}/ws/proctoring/${attemptId}/?role=streamer`);
    wsRef.current = ws;

    let timer: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      // Token URL'da emas, birinchi xabarda: access-loglarga tushmasin.
      ws.send(JSON.stringify({ type: "auth", token }));
      timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ws.send(JSON.stringify({ type: "frame", data: canvas.toDataURL("image/jpeg", 0.4) }));
      }, 200);
      intervalRef.current = timer;
    };

    ws.onclose = () => {
      // faqat shu ulanishning intervalini to'xtatamiz (keyingi start()nikini emas)
      if (timer !== null) clearInterval(timer);
      if (intervalRef.current === timer) intervalRef.current = null;
      if (wsRef.current === ws) wsRef.current = null;
    };

    ws.onerror = (err) => { console.warn("[proctoring] ws error:", err); ws.close(); };
  }, [acquireCamera]);

  const stop = useCallback(() => {
    runRef.current += 1;
    if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
    wsRef.current?.close();
    wsRef.current = null;
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setCameraStatus("idle");
  }, []);

  // Sahifadan chiqilganda (unmount) kamera, WS va interval o'chsin
  useEffect(() => stop, [stop]);

  return { acquireCamera, start, stop, stream, cameraStatus };
}
