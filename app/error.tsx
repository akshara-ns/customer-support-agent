"use client";

/** Error boundary for the app's pages: a recovery state instead of a blank page. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p className="muted">The page hit an unexpected error. Your conversation is saved on the server.</p>
      {error.digest && <p className="small muted">Reference: {error.digest}</p>}
      <div className="header-actions">
        <button type="button" onClick={reset}>
          Try again
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            localStorage.removeItem("fernway.sessionId");
            location.reload();
          }}
        >
          Start a new conversation
        </button>
      </div>
    </main>
  );
}
