// Session: the per-request auth + feature-flag envelope the SPA boots from.

export type Session = {
  authenticated: boolean;
  username: string;
  imageGenEnabled: boolean;
  studioEnabled: boolean;
  chatEnabled: boolean;
  // Studio history needs the library store, not the studio provider — an install
  // with no database can generate but keeps nothing.
  historyEnabled: boolean;
  alignmentEnabled: boolean;
  imageModels: string[];
  defaultImageModel: string;
  authMode: string;
};

export async function getSession(): Promise<Session> {
  const r = await fetch("/api/auth/session");
  return r.json();
}
