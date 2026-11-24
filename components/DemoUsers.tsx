import type { DemoUser } from "@/lib/tools/customers";

/** Fake accounts reviewers can use; PINs are shown on purpose. */
export function DemoUsers({ users }: { users: DemoUser[] }) {
  return (
    <aside className="demo-users" aria-label="Demo users">
      <h2>Demo users</h2>
      <p className="muted small">Fictional accounts. Give the email and PIN in the chat to verify.</p>
      <ul>
        {users.map((u) => (
          <li key={u.email}>
            <div className="demo-row">
              <strong>{u.name}</strong>
              <span className={`badge badge-${u.tier}`}>{u.tier}</span>
              {u.contractStatus !== "active" && <span className="badge badge-warn">{u.contractStatus}</span>}
            </div>
            <code className="small">
              {u.email} · PIN {u.pin}
            </code>
            <p className="muted small">Try: {u.tryThis}</p>
          </li>
        ))}
      </ul>
    </aside>
  );
}
