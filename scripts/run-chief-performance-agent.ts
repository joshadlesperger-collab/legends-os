import { loadSalesVelocity } from "../lib/sales-velocity.ts";
import { buildPerformanceReportCard } from "../lib/chief-performance-agent.ts";

// Read-only on-demand runner. Scheduler/persistence must be wired and verified separately.
async function main() {
  const report=buildPerformanceReportCard(await loadSalesVelocity());
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
}
main().catch(error=>{console.error("Chief Performance Agent failed:",error instanceof Error?error.message:"unknown error");process.exitCode=1;});
