import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_REPO, platform } from "../testing/harness";

afterEach(() => vi.unstubAllGlobals());

// Sign-in is identity, not a wiki: it must work whichever repo a request names —
// or none — and even when the Engine's own default repo isn't served (e.g. its
// REPO_NAME lags a GitHub rename). Otherwise the reader hides the sign-in button.
describe("journey: sign in", () => {
  async function unservedDefault() {
    const p = await platform({
      OAUTH_CLIENT_ID: "client",
      OAUTH_CLIENT_SECRET: "secret",
      ALLOWED_ORIGIN: "https://wikigit.org,https://*.wikigit.org",
    });
    p.gh.repo(OPERATOR_REPO).installed = false;
    return p;
  }

  it("reports the sign-in providers without naming a repo", async () => {
    const p = await unservedDefault();
    const res = await p.call("GET", "/auth/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ providers: { github: true } });
  });

  it("starts the GitHub sign-in without naming a repo", async () => {
    const p = await unservedDefault();
    const res = await p.call(
      "GET",
      `/auth/login?provider=github&return=${encodeURIComponent("https://wikigit.org/")}`,
    );
    expect(res.status).toBe(302);
  });
});
