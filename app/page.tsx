import { Chat } from "@/components/Chat";
import { DemoUsers } from "@/components/DemoUsers";
import { HealthStatus } from "@/components/HealthStatus";
import { demoUsers } from "@/lib/tools/customers";

export default function Home() {
  return (
    <main className="layout">
      <Chat />
      <div className="side">
        <DemoUsers users={demoUsers()} />
        <details className="small">
          <summary>Backend health</summary>
          <HealthStatus />
        </details>
      </div>
    </main>
  );
}
