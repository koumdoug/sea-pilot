"use client";

import { useState } from "react";
import { buttonClass } from "./ui";

export function CopyButton({ text, label = "Copier" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  return (
    <button type="button" className={buttonClass("secondary", "sm")} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setState("ok"); } catch { setState("err"); }
      setTimeout(() => setState("idle"), 2000);
    }}>
      {state === "ok" ? "Copié ✓" : state === "err" ? "Copie impossible" : label}
    </button>
  );
}
