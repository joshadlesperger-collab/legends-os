import type { ReactNode } from "react";

type TableDetailProps = { summary: string; label?: string; children: ReactNode };

/** Keeps dense rows scannable while retaining the complete accessible explanation. */
export default function TableDetail({ summary, label = "Why?", children }: TableDetailProps) {
  return <details className="table-detail"><summary><span className="table-detail-summary" title={summary}>{summary}</span><span className="table-detail-label">{label}</span></summary><div className="table-detail-content">{children}</div></details>;
}
