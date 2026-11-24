import { HealthStatus } from "@/components/HealthStatus";

export default function Home() {
  return (
    <main>
      <h1>Support Agent</h1>
      <p className="muted">Streaming chat and live voice support. Scaffold build: backend health below.</p>
      <HealthStatus />
    </main>
  );
}
