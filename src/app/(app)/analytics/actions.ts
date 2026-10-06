"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionState, UserError } from "@/lib/action";
import { importMetricsCsv } from "@/lib/csv";

export async function importCsvAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const file = fd.get("file");
    let text = String(fd.get("text") ?? "");
    if (file instanceof File && file.size > 0) {
      if (file.size > 1_500_000) throw new UserError("Fichier trop volumineux (1,5 Mo max).");
      text = await file.text();
    }
    if (!text.trim()) throw new UserError("Choisissez un fichier CSV ou collez son contenu.");
    const r = await importMetricsCsv(ctx.workspaceId, text);
    revalidatePath("/analytics"); revalidatePath("/dashboard");
    if (r.imported === 0) throw new UserError(r.errors.slice(0, 5).map((e) => `Ligne ${e.line} : ${e.message}`).join(" · ") || "Aucune ligne importée.");
    const warn = r.errors.length ? ` ${r.errors.length} ligne(s) ignorée(s) : ${r.errors.slice(0, 3).map((e) => `L${e.line} ${e.message}`).join(" ; ")}` : "";
    return { ok: true, message: `${r.imported} ligne(s) importée(s).${warn}` };
  });
}
