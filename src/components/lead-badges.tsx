import { LEAD_STATUS_LABEL, LEVEL_LABEL, type LeadStatus } from "@/lib/constants";
import { Badge, type Tone } from "./ui";

const STATUS_TONE: Record<string, Tone> = { new: "blue", contacted: "orange", qualified: "green", proposal: "purple", won: "green", lost: "red", disqualified: "gray" };
const LEVEL_TONE: Record<string, Tone> = { hot: "red", warm: "orange", cold: "blue", unqualified: "gray" };

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status] ?? "gray"}>{LEAD_STATUS_LABEL[status as LeadStatus] ?? status}</Badge>;
export const LevelBadge = ({ level, score }: { level: string | null; score?: number | null }) =>
  level ? <Badge tone={LEVEL_TONE[level] ?? "gray"}>{LEVEL_LABEL[level] ?? level}{score != null ? ` · ${score}` : ""}</Badge> : <span className="text-slate-400">—</span>;
