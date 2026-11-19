import { afterEach, describe, expect, it, vi } from "vitest";
import { anon, github, platform } from "../testing/harness";

afterEach(() => vi.unstubAllGlobals());

// A connected wiki owned by alice, so `alice` is its maintainer; everyone else
// starts at the `open` tier (edits go to review under the default policy).
const WIKI = "alice/notes";
const HOME = "# Notes\n\nWelcome.\n";

async function wiki(overrides = {}) {
  const p = await platform(overrides);
  p.gh.createRepo(WIKI, { "content/index.md": HOME });
  return {
    ...p,
    alice: await github("alice", 1),
    bob: await github("bob", 2),
    save: (as: { token?: string; ip?: string }, slug: string, content: string) =>
      p.call<{ live: boolean; author: string; prUrl?: string }>("POST", "/edit", {
        as,
        repo: WIKI,
        body: { slug, content },
      }),
    get: <T = Record<string, unknown>>(
      path: string,
      as?: { token?: string; ip?: string },
    ) => p.call<T>("GET", path, { repo: WIKI, as }),
    post: (path: string, body: unknown, as: { token?: string; ip?: string }) =>
      p.call("POST", path, { repo: WIKI, body, as }),
  };
}

type Pending = {
  pending: { number: number; slug: string; author: string; isAnon: boolean }[];
};
type History = { revisions: { sha: string; author: string; message: string }[] };

describe("journey: create a page", () => {
  it("a maintainer's new page goes live and shows up everywhere", async () => {
    const w = await wiki();
    const content = "# Setup guide\n\nInstall the [[index|tools]].\n";
    const res = await w.save(w.alice, "guides/setup", content);
    expect(res.body).toMatchObject({ live: true, author: "alice" });

    expect(w.gh.file(WIKI, "content/guides/setup.md")).toBe(content);
    expect((await w.get("/pages")).body).toEqual({ pages: ["guides/setup", "index"] });

    const version = await w.get<{ sha: string; versions: Record<string, string> }>(
      "/version",
    );
    expect(version.body.sha).toBe(w.gh.repo(WIKI).branches.get("main"));
    expect(Object.keys(version.body.versions).sort()).toEqual([
      "guides/setup",
      "index",
    ]);

    const search = await w.get<{ docs: { slug: string; title: string }[] }>(
      "/search-index",
    );
    expect(search.body.docs.map((d) => d.slug)).toContain("guides/setup");

    const history = await w.get<History>("/history?slug=guides/setup");
    expect(history.body.revisions).toHaveLength(1);
    expect(history.body.revisions[0].author).toBe("alice");
    expect(w.gh.openPulls(WIKI)).toEqual([]);
    expect([...w.gh.repo(WIKI).branches.keys()]).toEqual(["main"]);
  });

  it("keeps accents and emoji byte-exact", async () => {
    const w = await wiki();
    const content = "# Café ☕\n\nCrème brûlée, naïve façade — 日本語 🎉\n";
    await w.save(w.alice, "cafe", content);
    expect(w.gh.file(WIKI, "content/cafe.md")).toBe(content);
  });

  it("an anonymous visitor's new page waits for review, then goes live when approved", async () => {
    const w = await wiki();
    const visitor = anon("203.0.113.7");
    const content = "# Tips\n\nA visitor's tip.\n";

    const res = await w.save(visitor, "tips", content);
    expect(res.body).toMatchObject({ live: false });
    expect(res.body.author).toMatch(/^anon-/);
    expect(w.gh.file(WIKI, "content/tips.md")).toBeUndefined();
    expect((await w.get("/pages")).body).toEqual({ pages: ["index"] });

    const queue = await w.get<Pending>("/pending");
    expect(queue.body.pending).toEqual([
      expect.objectContaining({ slug: "tips", author: res.body.author, isAnon: true }),
    ]);

    const denied = await w.post(
      "/review",
      { number: queue.body.pending[0].number, action: "merge" },
      visitor,
    );
    expect(denied.status).toBe(403);

    const approved = await w.post(
      "/review",
      { number: queue.body.pending[0].number, action: "merge" },
      w.alice,
    );
    expect(approved.status).toBe(200);
    expect(w.gh.file(WIKI, "content/tips.md")).toBe(content);
    expect((await w.get<Pending>("/pending")).body.pending).toEqual([]);
    expect((await w.get("/pages")).body).toEqual({ pages: ["index", "tips"] });
    const search = await w.get<{ docs: { slug: string }[] }>("/search-index");
    expect(search.body.docs.map((d) => d.slug)).toContain("tips");

    const history = await w.get<History>("/history?slug=tips");
    expect(history.body.revisions.map((r) => r.author)).toEqual([res.body.author]);
    expect([...w.gh.repo(WIKI).branches.keys()]).toEqual(["main"]);
  });

  it("a rejected page never goes live and leaves nothing behind", async () => {
    const w = await wiki();
    await w.save(anon("203.0.113.7"), "spam", "# Buy now\n");
    const [pr] = (await w.get<Pending>("/pending")).body.pending;

    const res = await w.post(
      "/review",
      { number: pr.number, action: "close" },
      w.alice,
    );
    expect(res.status).toBe(200);
    expect(w.gh.file(WIKI, "content/spam.md")).toBeUndefined();
    expect((await w.get<Pending>("/pending")).body.pending).toEqual([]);
    expect([...w.gh.repo(WIKI).branches.keys()]).toEqual(["main"]);
  });

  it("only a profile's owner can write their user page", async () => {
    const w = await wiki();
    expect((await w.save(w.bob, "user/bob", "# Bob\n")).body).toMatchObject({
      live: true,
    });
    expect((await w.save(w.alice, "user/bob", "# Not Bob\n")).status).toBe(403);
    expect((await w.save(anon("203.0.113.7"), "user/bob", "# Anon\n")).status).toBe(
      403,
    );
    expect(w.gh.file(WIKI, "content/user/bob.md")).toBe("# Bob\n");
  });

  it("rejects malformed page addresses", async () => {
    const w = await wiki();
    for (const slug of [
      "",
      "../secrets",
      "Upper",
      "a//b",
      "/lead",
      "trail/",
      "sp ace",
    ]) {
      expect((await w.save(w.alice, slug, "# x\n")).status, slug).toBe(400);
    }
  });
});

describe("journey: edit a page", () => {
  it("a maintainer's edit is live, in history, and diffable", async () => {
    const w = await wiki();
    const next = "# Notes\n\nWelcome, readers.\n";
    const res = await w.save(w.alice, "index", next);
    expect(res.body).toMatchObject({ live: true });
    expect(w.gh.file(WIKI, "content/index.md")).toBe(next);

    const history = await w.get<History>("/history?slug=index");
    const [latest, original] = history.body.revisions;
    expect(history.body.revisions).toHaveLength(2);
    expect(latest.author).toBe("alice");

    const diff = await w.get<{ patch: string }>(
      `/diff?slug=index&base=${original.sha}&head=${latest.sha}`,
    );
    expect(diff.body.patch).toContain("-Welcome.");
    expect(diff.body.patch).toContain("+Welcome, readers.");
  });

  it("saving without changes is a no-op success", async () => {
    const w = await wiki();
    const commits = w.gh.history(WIKI).length;
    const res = await w.save(w.alice, "index", HOME);
    expect(res.body).toMatchObject({ live: true });
    expect(w.gh.history(WIKI)).toHaveLength(commits);
    expect(w.gh.openPulls(WIKI)).toEqual([]);
  });

  it("a visitor's repeated edits before review stay in one request, latest wins", async () => {
    const w = await wiki();
    const visitor = anon("203.0.113.7");
    await w.save(visitor, "index", "# Notes\n\nFirst try.\n");
    await w.save(visitor, "index", "# Notes\n\nSecond try.\n");

    const queue = (await w.get<Pending>("/pending")).body.pending;
    expect(queue).toHaveLength(1);
    await w.post("/review", { number: queue[0].number, action: "merge" }, w.alice);
    expect(w.gh.file(WIKI, "content/index.md")).toBe("# Notes\n\nSecond try.\n");
  });

  it("a visitor can propose again after a rejection", async () => {
    const w = await wiki();
    const visitor = anon("203.0.113.7");
    await w.save(visitor, "index", "# Notes\n\nBad edit.\n");
    const [first] = (await w.get<Pending>("/pending")).body.pending;
    await w.post("/review", { number: first.number, action: "close" }, w.alice);

    await w.save(visitor, "index", "# Notes\n\nBetter edit.\n");
    const [second] = (await w.get<Pending>("/pending")).body.pending;
    expect(second.number).not.toBe(first.number);
    await w.post("/review", { number: second.number, action: "merge" }, w.alice);
    expect(w.gh.file(WIKI, "content/index.md")).toBe("# Notes\n\nBetter edit.\n");
  });

  it("two visitors editing the same page get separate review requests", async () => {
    const w = await wiki();
    const a = await w.save(anon("203.0.113.7"), "index", "# Notes\n\nFrom A.\n");
    const b = await w.save(anon("198.51.100.9"), "index", "# Notes\n\nFrom B.\n");
    expect(a.body.author).not.toBe(b.body.author);

    const queue = (await w.get<Pending>("/pending")).body.pending;
    expect(queue.map((q) => q.author).sort()).toEqual(
      [a.body.author, b.body.author].sort(),
    );
  });

  it("approving the second of two conflicting edits fails cleanly and keeps it queued", async () => {
    const w = await wiki();
    await w.save(anon("203.0.113.7"), "index", "# Notes\n\nFrom A.\n");
    await w.save(anon("198.51.100.9"), "index", "# Notes\n\nFrom B.\n");
    const [newest, oldest] = (await w.get<Pending>("/pending")).body.pending;

    expect(
      (await w.post("/review", { number: oldest.number, action: "merge" }, w.alice))
        .status,
    ).toBe(200);
    const conflict = await w.post(
      "/review",
      { number: newest.number, action: "merge" },
      w.alice,
    );
    expect(conflict.status).toBe(409);
    expect(w.gh.file(WIKI, "content/index.md")).toBe("# Notes\n\nFrom A.\n");
    expect(
      (await w.get<Pending>("/pending")).body.pending.map((p) => p.number),
    ).toEqual([newest.number]);
  });

  it("a banned visitor can no longer propose edits", async () => {
    const w = await wiki();
    const visitor = anon("203.0.113.7");
    const first = await w.save(visitor, "index", "# Notes\n\nVandalism.\n");
    const ban = await w.post(
      "/ban",
      { key: first.body.author, reason: "vandalism" },
      w.alice,
    );
    expect(ban.status).toBe(200);

    const again = await w.save(visitor, "index", "# Notes\n\nMore vandalism.\n");
    expect(again.status).toBe(403);
    const other = await w.save(anon("198.51.100.9"), "index", "# Notes\n\nFine.\n");
    expect(other.status).toBe(200);
  });
});

describe("journey: anonymous identity on the self-hosted (Bun) Engine", () => {
  // Behind Coolify/Traefik there is no CF-Connecting-IP: the proxy reports the
  // visitor in X-Forwarded-For.
  async function whoamiViaProxy(
    w: Awaited<ReturnType<typeof wiki>>,
    headers: Record<string, string>,
  ) {
    const res = await w.call<{ author: string }>("GET", "/whoami", {
      repo: WIKI,
      as: { headers },
      viaBunServer: true,
    });
    return res.body.author;
  }

  it("tells two visitors apart", async () => {
    const w = await wiki();
    const a = await whoamiViaProxy(w, { "X-Forwarded-For": "203.0.113.7" });
    const b = await whoamiViaProxy(w, { "X-Forwarded-For": "198.51.100.9" });
    expect(a).not.toBe(b);
  });

  it("won't let a visitor pick someone else's identity", async () => {
    const w = await wiki();
    const victim = await whoamiViaProxy(w, { "X-Forwarded-For": "203.0.113.7" });
    const spoofed = await whoamiViaProxy(w, {
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "203.0.113.7, 198.51.100.9",
    });
    expect(spoofed).not.toBe(victim);
  });

  it("a banned visitor stays banned however they dress the request", async () => {
    const w = await wiki();
    const visitor = { "X-Forwarded-For": "203.0.113.7" };
    const first = await w.call<{ author: string }>("POST", "/edit", {
      repo: WIKI,
      as: { headers: visitor },
      viaBunServer: true,
      body: { slug: "index", content: "# Notes\n\nVandalism.\n" },
    });
    await w.post("/ban", { key: first.body.author }, w.alice);

    const retry = await w.call("POST", "/edit", {
      repo: WIKI,
      as: { headers: { ...visitor, "CF-Connecting-IP": "192.0.2.1" } },
      viaBunServer: true,
      body: { slug: "index", content: "# Notes\n\nMore vandalism.\n" },
    });
    expect(retry.status).toBe(403);
  });
});

describe("journey: reorganise pages", () => {
  it("moving a page leaves a redirect and the new page is readable", async () => {
    const w = await wiki();
    await w.save(w.alice, "draft", "# Draft\n\nBody.\n");
    const res = await w.post("/move", { from: "draft", to: "final" }, w.alice);
    expect(res.status).toBe(200);
    expect(w.gh.file(WIKI, "content/final.md")).toContain("Body.");
    expect(w.gh.file(WIKI, "content/draft.md")).toMatch(/redirect: final/);
    const graph = await w.get<{ nodes: unknown }>("/link-graph");
    expect(JSON.stringify(graph.body)).toContain("final");
  });

  it("deleting a page removes it from the wiki, and restoring brings it back", async () => {
    const w = await wiki();
    await w.save(w.alice, "old", "# Old\n");
    const [created] = (await w.get<History>("/history?slug=old")).body.revisions;

    expect((await w.post("/delete", { slug: "old" }, w.alice)).status).toBe(200);
    expect(w.gh.file(WIKI, "content/old.md")).toBeUndefined();
    expect((await w.get("/pages")).body).toEqual({ pages: ["index"] });
    const search = await w.get<{ docs: { slug: string }[] }>("/search-index");
    expect(search.body.docs.map((d) => d.slug)).not.toContain("old");

    expect(
      (await w.post("/restore", { slug: "old", rev: created.sha }, w.alice)).status,
    ).toBe(200);
    expect(w.gh.file(WIKI, "content/old.md")).toBe("# Old\n");
    expect((await w.get("/pages")).body).toEqual({ pages: ["index", "old"] });
  });

  it("only maintainers can move or delete", async () => {
    const w = await wiki();
    expect((await w.post("/delete", { slug: "index" }, w.bob)).status).toBe(403);
    expect((await w.post("/move", { from: "index", to: "home" }, w.bob)).status).toBe(
      403,
    );
    expect(w.gh.file(WIKI, "content/index.md")).toBe(HOME);
  });
});
