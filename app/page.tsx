import Link from 'next/link';
import { RecordTile } from '@/components/RecordTile';

// Dashboard index. Read-mostly (CLAUDE.md build order): the write path is
// Telegram + ingestion scripts; these tiles are visualization over the dbt
// marts. Each tile links to a mart-backed view as it lands (Phase 3). The
// recorder comes first: it's the app's main write path (MZY-287).
export default function Home() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>Agon</h1>
        <p className="sub">Your body, logged. Your progress, earned.</p>
      </header>

      <nav className="tiles">
        <RecordTile />
        <Link href="/training-load" className="tile">
          <h2>Training load →</h2>
          <p>Fitness, Fatigue &amp; Form (CTL / ATL / TSB)</p>
        </Link>
        <Link href="/race-predictions" className="tile">
          <h2>Race predictions →</h2>
          <p>Predicted times 1k–70k (self-recalibrated Riegel)</p>
        </Link>
        <Link href="/relative-effort" className="tile">
          <h2>Relative Effort →</h2>
          <p>Per-run training load (Banister TRIMP)</p>
        </Link>
        <Link href="/runs" className="tile">
          <h2>Runs →</h2>
          <p>Recent runs, GPS route &amp; HR streams</p>
        </Link>
        <Link href="/run-compliance" className="tile">
          <h2>Run compliance →</h2>
          <p>Weekly km vs. plan, easy-run HR-cap adherence</p>
        </Link>
        <Link href="/rides" className="tile">
          <h2>Rides →</h2>
          <p>Recent bike rides, GPS route &amp; HR streams</p>
        </Link>
        <Link href="/gear" className="tile">
          <h2>Gear →</h2>
          <p>Total mileage per shoe, bike &amp; other gear</p>
        </Link>
        <Link href="/wellness" className="tile">
          <h2>Wellness &amp; recovery →</h2>
          <p>Resting HR, HRV &amp; sleep over time</p>
        </Link>
        <Link href="/body-comp" className="tile">
          <h2>Body composition →</h2>
          <p>Weight &amp; body fat since training start</p>
        </Link>
        <Link href="/nutrition" className="tile">
          <h2>Nutrition →</h2>
          <p>Water &amp; supplement goals, usual meals</p>
        </Link>
        <Link href="/health" className="tile">
          <h2>General health →</h2>
          <p>Test results, routines, meds, injuries &amp; more</p>
        </Link>
      </nav>
    </main>
  );
}
