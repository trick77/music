import { useEffect, useState } from "react";

type Session = { authenticated: boolean; username: string };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, username: "" }));
  }, []);
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: "2rem", margin: 0 }}>Music</h1>
        <p style={{ color: "var(--color-muted)" }}>
          {session == null
            ? "…"
            : session.authenticated
              ? `Signed in as ${session.username}`
              : "Browsing as guest"}
        </p>
      </div>
    </main>
  );
}
