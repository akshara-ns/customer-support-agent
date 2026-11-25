import { Chat } from "@/components/Chat";
import { DemoUsers } from "@/components/DemoUsers";
import { HealthPanel } from "@/components/HealthStatus";
import { TryThis } from "@/components/TryThis";
import { demoUsers } from "@/lib/server/deps";

export default function Home() {
  return (
    <main className="layout">
      <Chat />
      <div className="side">
        <TryThis />
        <DemoUsers users={demoUsers()} />
        <HealthPanel />
      </div>
    </main>
  );
}
