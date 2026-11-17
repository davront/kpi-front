"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { isClientAuthed, subscribeAuth } from "@/lib/auth-storage";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const authed = useSyncExternalStore(
    subscribeAuth,
    () => isClientAuthed(),
    () => false,
  );

  useEffect(() => {
    // Gidratsiyada `authed` server snapshot (false) bo'ladi — sessionStorage'ni bevosita tekshiramiz,
    // aks holda F5 / to'g'ridan-to'g'ri URL har doim "/" ga otib yuboradi.
    if (!isClientAuthed()) {
      router.replace("/");
    }
  }, [authed, router]);

  if (!authed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-zinc-500">
        Yuklanmoqda…
      </div>
    );
  }

  return <>{children}</>;
}
