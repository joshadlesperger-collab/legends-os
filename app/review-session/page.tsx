import Link from "next/link";
import { actionEffort, buildActionBrief } from "@/lib/action-presentation";
import { compareQueuePriority, inventoryActionQueues, matchesInventoryActionQueue } from "@/lib/inventory-action-queues";
import { loadInventoryHealth } from "@/lib/inventory-health-data";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
const usd = (value: number | null) => value == null ? "Not available" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

export default async function ReviewSessionPage({ searchParams }: { searchParams?: { issue?: string } }) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const issue = searchParams?.issue ?? "";
  const queue = inventoryActionQueues.find((item) => item.id === issue) ?? inventoryActionQueues[0];
  const [data, handled] = await Promise.all([loadInventoryHealth(now), prisma.operatorDecision.findMany({ where: { decidedAt: { gte: today } }, select: { listingId: true } })]);
  const handledIds = new Set(handled.map((item) => item.listingId));
  const actions = data.rows.filter((row) => !handledIds.has(row.id) && matchesInventoryActionQueue(row, issue)).sort(compareQueuePriority(issue)).slice(0, 15);
  const row = actions[0];
  const brief = row ? buildActionBrief(row) : null;

  return <main className="page-shell review-session"><div className="eyebrow">Prescriptive operator session</div><h1>{queue.label}</h1><p>One evidence-backed decision at a time. Read the diagnosis, manual steps, evidence, and approval meaning before recording a plan.</p>
    <nav className="review-queue-nav" aria-label="Inventory action workflows">{inventoryActionQueues.map((item) => <Link aria-current={item.id === queue.id ? "page" : undefined} key={item.id} href={`/review-session${item.id ? `?issue=${item.id}` : ""}`}>{item.label}</Link>)}</nav>
    <section className="panel review-progress"><div><strong>{row ? `${Math.min(handledIds.size + 1, 15)} of 15` : "Complete"}</strong><p>{handledIds.size} unique listing decision{handledIds.size === 1 ? "" : "s"} recorded today</p></div><Link href="/action-history">View Action History →</Link></section>
    {row && brief ? <article className="panel review-card"><div className="action-top"><span className="pill">Doctrine {row.doctrine.doctrineVersion}</span><span className="pill">{actionEffort(row.doctrine.interventionSelected)}</span></div><h2>{row.title}</h2><div className="metric-grid"><div className="metric"><div className="metric-label">Problem Confidence</div><div className="metric-value">{row.doctrine.problemConfidence.score}</div><div className="metric-detail">{row.doctrine.problemConfidence.band}</div></div><div className="metric"><div className="metric-label">Action Confidence</div><div className="metric-value">{row.doctrine.actionConfidence.score}</div><div className="metric-detail">{row.doctrine.actionConfidence.band}</div></div><div className="metric"><div className="metric-label">Comp Confidence</div><div className="metric-value">{row.doctrine.compConfidence??"—"}</div><div className="metric-detail">Independent sold-evidence score</div></div><div className="metric"><div className="metric-label">Sale Likelihood</div><div className="metric-value" style={{fontSize:20}}>{row.doctrine.saleLikelihood}</div><div className="metric-detail">Directional, not probability</div></div></div>
      <ReviewBlock number="1" eyebrow={`Diagnosis · ${row.doctrine.diagnosticFunnelStage}`} title={`FIRST ACTION: ${row.doctrine.interventionSelected.replaceAll("_"," ")}`}><p>{brief.diagnosis}</p><ul>{row.doctrine.problemsDetected.map(problem=><li key={problem}>{problem}</li>)}</ul><p className="metric-detail">Health {row.healthScore}/100 · {usd(row.listedExposure)} listed exposure</p></ReviewBlock>
      <ReviewBlock number="2" eyebrow="Recommended manual action" title={brief.recommendation}><ol>{brief.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="review-tools" style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap",marginTop:12}}>{row.ebayItemId ? <a className="btn-secondary" href={`https://www.ebay.com/itm/${encodeURIComponent(row.ebayItemId)}`} target="_blank" rel="noreferrer">Open live eBay listing ↗</a> : <span className="text-muted">Live listing link unavailable</span>}{row.compConfidence != null ? <Link href={`/comp-validation?listingId=${row.id}`}>View comp evidence →</Link> : null}{row.recommendedAction === "ENTER COST" ? <Link href="/cost-basis">Open Cost Basis →</Link> : null}</div></ReviewBlock>
      <ReviewBlock number="3" eyebrow="Supporting evidence" title="Signals evaluated"><ul>{brief.evidence.map((item) => <li key={item}>{item}</li>)}</ul>{row.doctrine.evidenceGaps.length?<details><summary>Evidence still missing</summary><ul>{row.doctrine.evidenceGaps.map(gap=><li key={gap.code}><strong>{gap.code.replaceAll("_"," ")}</strong> â€” blocks {gap.blocks.join(" and ")}; {gap.automatic?`Legends can recover this from ${gap.recoverableFrom}`:"operator documentation is required"}.</li>)}</ul></details>:null}<details><summary>Alternatives rejected or deferred</summary><ul>{row.doctrine.alternativesRejectedOrDeferred.map(item=><li key={item}>{item}</li>)}</ul></details><p><strong>If this does not work:</strong> {row.doctrine.evaluateNextIfInterventionFails}</p></ReviewBlock>
      <ReviewBlock number="4" eyebrow="What approval means" title={brief.approvalMeaning} emphasis><p>{brief.guardrail}</p><p>Observation window: {row.doctrine.observationWindowDays} days.</p></ReviewBlock>
      <form method="post" action={`/api/inventory-actions/${row.id}/decisions`} className="review-actions"><input type="hidden" name="next" value={`/review-session${issue ? `?issue=${issue}` : ""}`} /><button className="btn-primary" name="decision" value="follow_recommendation">APPROVE PLAN — RECORD MY INTENT</button><button name="decision" value="keep_current">KEEP CURRENT APPROACH</button><button name="decision" value="defer">REVIEW LATER</button></form>
    </article> : <section className="empty-state review-card"><h2>Today’s review is complete</h2><p>No additional listings are waiting in this category. Legends will continue observing authoritative data.</p></section>}
    {actions.length > 1 ? <section className="panel review-next"><div className="eyebrow">Coming next</div><ul>{actions.slice(1, 4).map((item) => <li key={item.id}>{item.title} · {item.rootCauseLabel}</li>)}</ul></section> : null}
  </main>;
}

function ReviewBlock({ number, eyebrow, title, children, emphasis = false }: { number: string; eyebrow: string; title: string; children: React.ReactNode; emphasis?: boolean }) {
  return <section className={`review-diagnostic${emphasis ? " review-approval" : ""}`}><div className="review-step-number" aria-hidden="true">{number}</div><div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3>{children}</div></section>;
}
