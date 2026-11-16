import { renderConsentPage } from "./consent-template";

type ConsentParams = Parameters<typeof renderConsentPage>[0];

function render(overrides: Partial<ConsentParams> = {}): string {
  return renderConsentPage({
    uid: "abc-123",
    clientName: "Claude Desktop",
    clientUri: "https://claude.ai",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    userEmail: "user@example.com",
    scopes: ["monize:read", "monize:write"],
    resource: "https://monize.example/api/v1/mcp",
    ...overrides,
  });
}

describe("renderConsentPage", () => {
  it("renders the requested scopes as a read-only list", () => {
    const html = render();

    expect(html).toContain("Authorize");
    expect(html).toContain("Claude Desktop");
    expect(html).toContain("user@example.com");
    // Human-readable scope labels are shown...
    expect(html).toContain("Read your financial data");
    expect(html).toContain("Modify your financial data");
    // ...but there are no per-scope toggles (granular consent is not offered).
    expect(html).not.toContain("<input");
    expect(html).not.toContain('name="scopes"');
    expect(html).toContain('action="/api/v1/oauth-consent/abc-123/confirm"');
    expect(html).toContain('formaction="/api/v1/oauth-consent/abc-123/abort"');
  });

  it("escapes user-controlled inputs to prevent stored XSS", () => {
    const html = render({
      uid: "uid",
      clientName: "<script>alert(1)</script>",
      clientUri: 'javascript:alert(1)" autofocus="',
      redirectUri: "https://evil.example/cb",
      userEmail: '"><img src=x onerror=alert(1)>',
      scopes: [],
      resource: 'res"><img>',
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('"><img');
    expect(html).not.toContain('" autofocus="');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("renders an empty scope list when no scopes are granted", () => {
    const html = render({ clientUri: null, scopes: [] });

    // Form still renders so user can deny; scopes ul is empty.
    expect(html).toContain('class="scopes">');
    expect(html).not.toContain('value="monize:read"');
  });

  describe("destination of the authorization (open client registration)", () => {
    it("shows the origin of the redirect_uri, with scheme and a non-default port", () => {
      const html = render({
        clientUri: null,
        redirectUri: "https://evil.example:8443/oauth/cb?state=1",
      });

      expect(html).toContain('<p class="origin">https://evil.example:8443</p>');
      // The path and query are not the destination and are not shown.
      expect(html).not.toContain("/oauth/cb");
    });

    it("shows an internationalised host in its ASCII form, not a look-alike", () => {
      const html = render({
        clientUri: null,
        redirectUri: "https://clаude.ai/cb", // Cyrillic a
      });

      expect(html).toContain('<p class="origin">https://xn--clude-');
    });

    it("shows a custom-scheme redirect as scheme and host", () => {
      const html = render({
        clientUri: null,
        redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback",
      });

      expect(html).toContain(
        '<p class="origin">cursor://anysphere.cursor-mcp</p>',
      );
    });

    it("warns instead of naming a destination when the redirect_uri is missing or unparseable", () => {
      for (const redirectUri of [null, "", "not a url"]) {
        const html = render({ redirectUri });
        expect(html).not.toContain('class="origin"');
        expect(html).toContain("could not determine where");
      }
    });

    it("escapes a hostile redirect_uri", () => {
      const html = render({
        clientUri: null,
        redirectUri: "x-app://a/<img src=x onerror=alert(1)>",
      });

      expect(html).not.toContain("<img src=x");
    });

    it("says the application is self-registered and unverified", () => {
      const html = render();

      expect(html).toContain("registered itself with this Monize server");
      expect(html).toContain("has not verified who operates it");
      expect(html).toContain(
        "Only allow access if you started this connection yourself",
      );
    });

    it("never renders the client name as a link to its self-asserted client_uri", () => {
      const html = render();

      expect(html).not.toContain("<a ");
      expect(html).not.toContain('href="https://claude.ai"');
    });

    it("shows client_uri as a stated website when its host matches the redirect host", () => {
      const html = render();

      expect(html).toContain(
        "Website stated by the application: https://claude.ai",
      );
      expect(html).not.toContain("different address");
    });

    it("flags a client_uri whose host differs from where the code is sent", () => {
      const html = render({
        clientName: "Claude",
        clientUri: "https://claude.ai",
        redirectUri: "https://phish.example/callback",
      });

      expect(html).toContain('<p class="origin">https://phish.example</p>');
      expect(html).toContain(
        "The application says its website is https://claude.ai, but the authorization will be sent to a different address.",
      );
      expect(html).not.toContain("Website stated by the application");
    });

    it("flags a client_uri when the redirect destination is unknown", () => {
      const html = render({ redirectUri: null });

      expect(html).toContain("different address");
    });
  });
});
