import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./Rail";

// The rail's account slot is the only logout affordance in the app. It must
// submit a form, never follow a link: a GET logout is reachable from any page
// on the internet with an <img> tag, and the backend refuses one for that
// reason (POST /api/auth/logout, see httpapi.build).
describe("Rail logout control", () => {
  const render = (username: string) =>
    renderToStaticMarkup(
      <Rail
        route={{ name: "home" }}
        authenticated
        authMode="oidc"
        username={username}
        onUpload={() => {}}
        onQueue={() => {}}
      />,
    );

  it("posts a form rather than linking to the logout route", () => {
    const html = render("alice");
    expect(html).toContain('action="/api/auth/logout"');
    expect(html).toContain('method="post"');
    // The regression this guards: an anchor here is a one-tag forced logout.
    expect(html).not.toContain('href="/api/auth/logout"');
  });

  it("keeps the avatar initial on the submit button", () => {
    const html = render("alice");
    expect(html).toContain('aria-label="Log out"');
    expect(html).toContain(">A<");
  });

  it("falls back to the person glyph when no username is known", () => {
    const html = render("");
    expect(html).toContain('action="/api/auth/logout"');
    expect(html).toContain("<svg");
  });
});
