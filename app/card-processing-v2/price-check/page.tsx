import Link from "next/link";
import CardProcessingPriceCheck from "@/components/CardProcessingPriceCheck";
import CardProcessingPriceReport from "@/components/CardProcessingPriceReport";
import styles from "@/components/CardProcessingV2.module.css";

export const dynamic = "force-dynamic";

export default function PriceCheckPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <div><div className={styles.eyebrow}>Sell / Draft pricing</div><h1>Draft price review</h1><p>Review the saved full report, filter priced matches, and preview discounts.</p></div>
      <Link className={styles.quietLink} href="/card-processing-v2">Back to Card Processing V2</Link>
    </header>
    <CardProcessingPriceReport />
    <details><summary>Run a new check on selected drafts</summary><CardProcessingPriceCheck /></details>
  </main>;
}
