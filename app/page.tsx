import RecommendationDashboard from "@/components/RecommendationDashboard";
import Link from "next/link";

export default function Home() {
  return (
    <main style={{ width: "100%", maxWidth: "none", margin: "0 auto", padding: "24px 20px" }}>
      <div style={{ marginBottom: 12 }}>
        <Link href="/comp-validation">Open Comp Validation MVP</Link>
      </div>
      <RecommendationDashboard />
    </main>
  );
}
