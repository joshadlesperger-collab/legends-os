import RecommendationDashboard from "@/components/RecommendationDashboard";
import Link from "next/link";

export default function Home() {
  return (
    <main className="page" style={{ width: "100%", maxWidth: "none" }}>
      <div style={{ marginBottom: 12 }}>
        <Link href="/today" style={{ marginRight: 16 }}>Today</Link>
        <Link href="/sales" style={{ marginRight: 16 }}>Sales &amp; Performance</Link>
        <Link href="/comp-validation">Open Comp Validation MVP</Link>
      </div>
      <RecommendationDashboard />
    </main>
  );
}
