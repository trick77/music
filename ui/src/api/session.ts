// Session: the per-request auth + feature-flag envelope the SPA boots from.

export type Session = {
  authenticated: boolean;
  username: string;
  imageGenEnabled: boolean;
  studioEnabled: boolean;
  chatEnabled: boolean;
  alignmentEnabled: boolean;
  imageModels: string[];
  defaultImageModel: string;
  authMode: string;
};

export async function getSession(): Promise<Session> {
  const r = await fetch("/api/auth/session");
  return r.json();
}
