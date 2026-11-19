import { afterEach, describe, expect, it, vi } from "vitest";
import { anon, github, PLATFORM_ORG, platform } from "../testing/harness";

afterEach(() => vi.unstubAllGlobals());

// Running a freshly created hosted wiki: the creator shares rights, configures it,
// and opens pages to the public — the first things an owner does after claiming.
async function ownedWiki() {
  const p = await platform();
  const alice = await github("alice", 1);
  await p.call("POST", "/claim", { as: alice, body: { name: "recipes" } });
  const repo = `${PLATFORM_ORG}/recipes`;
  type As = { token?: string; ip?: string };
  return {
    ...p,
    repo,
    alice,
    bob: await github("bob", 2),
    get: <T = Record<string, unknown>>(path: string, as?: As) =>
      p.call<T>("GET", path, { repo, as }),
    post: <T = Record<string, unknown>>(path: string, body: unknown, as: As) =>
      p.call<T>("POST", path, { repo, body, as }),
    tierOf: async (as: As) =>
      (await p.call<{ tier: string }>("GET", "/whoami", { repo, as })).body.tier,
  };
}

describe("journey: share and run a wiki", () => {
  it("the owner grants a co-maintainer, whose edits then publish directly", async () => {
    const w = await ownedWiki();
    const before = await w.post<{ live: boolean }>(
      "/edit",
      { slug: "soup", content: "# Soup\n" },
      w.bob,
    );
    expect(before.body.live).toBe(false);

    expect((await w.post("/grant", { key: "gh:bob" }, w.alice)).status).toBe(200);
    expect(await w.tierOf(w.bob)).toBe("maintainer");
    const after = await w.post<{ live: boolean }>(
      "/edit",
      { slug: "bread", content: "# Bread\n" },
      w.bob,
    );
    expect(after.body.live).toBe(true);

    expect((await w.post("/revoke", { key: "gh:bob" }, w.alice)).status).toBe(200);
    expect(await w.tierOf(w.bob)).toBe("open");
  });

  it("a non-maintainer can't grant themselves rights or change settings", async () => {
    const w = await ownedWiki();
    expect((await w.post("/grant", { key: "gh:bob" }, w.bob)).status).toBe(403);
    expect((await w.post("/config", { title: "Hijacked" }, w.bob)).status).toBe(403);
    expect(await w.tierOf(w.bob)).toBe("open");
  });

  it("settings saved by the owner are what readers get, and the owner stays maintainer", async () => {
    const w = await ownedWiki();
    const loaded = await w.get<{ config: Record<string, unknown> }>("/config");
    // The settings form posts the loaded config back with the edited fields.
    const res = await w.post(
      "/config",
      { ...loaded.body.config, title: "Grandma's Recipes", tagline: "Since 1952" },
      w.alice,
    );
    expect(res.status).toBe(200);
    const config = await w.get<{ config: { title: string } }>("/config");
    expect(config.body.config.title).toBe("Grandma's Recipes");
    expect(await w.tierOf(w.alice)).toBe("maintainer");
  });

  it("the owner can't lock themselves out by clearing the maintainers list", async () => {
    const w = await ownedWiki();
    const before = w.gh.file(w.repo, "wikigit.json");
    const res = await w.post("/config", { title: "Recipes", maintainers: [] }, w.alice);
    expect(res.status).toBe(400);
    expect(w.gh.file(w.repo, "wikigit.json")).toBe(before);
    expect(await w.tierOf(w.alice)).toBe("maintainer");
  });

  it("the owner can hand settings to a co-maintainer while keeping their own access", async () => {
    const w = await ownedWiki();
    const res = await w.post(
      "/config",
      { title: "Recipes", maintainers: ["gh:alice", "bob"] },
      w.alice,
    );
    expect(res.status).toBe(200);
    expect(await w.tierOf(w.bob)).toBe("maintainer");

    const bobDropsAlice = await w.post(
      "/config",
      { title: "Recipes", maintainers: ["gh:bob"] },
      w.bob,
    );
    expect(bobDropsAlice.status).toBe(200);
    expect(await w.tierOf(w.alice)).toBe("open");
  });

  it("a connected repo's GitHub owner can clear the list — they stay maintainer as owner", async () => {
    const p = await platform();
    p.gh.createRepo("alice/notes", { "content/index.md": "# Notes\n" });
    const alice = await github("alice", 1);
    const res = await p.call("POST", "/config", {
      as: alice,
      repo: "alice/notes",
      body: { title: "Notes", maintainers: [] },
    });
    expect(res.status).toBe(200);
  });

  it("opening a page to everyone lets visitors publish to it directly", async () => {
    const w = await ownedWiki();
    const visitor = anon("203.0.113.7");
    expect(
      (await w.post("/protect", { slug: "index", tier: "open" }, w.alice)).status,
    ).toBe(200);

    const edit = await w.post<{ live: boolean }>(
      "/edit",
      {
        slug: "index",
        content: "---\nprotection: open\n---\n# Recipes\n\nAdd yours!\n",
      },
      visitor,
    );
    expect(edit.body.live).toBe(true);
    expect(w.gh.file(w.repo, "content/index.md")).toContain("Add yours!");
  });

  it("a visitor can't lift a page's protection by editing its front matter", async () => {
    const w = await ownedWiki();
    const res = await w.post(
      "/edit",
      { slug: "index", content: "---\nprotection: open\n---\n# Recipes\n" },
      anon("203.0.113.7"),
    );
    expect(res.status).toBe(403);
  });

  it("a maintainer can roll back a bad edit", async () => {
    const w = await ownedWiki();
    await w.post("/protect", { slug: "index", tier: "open" }, w.alice);
    const good = w.gh.file(w.repo, "content/index.md");
    await w.post(
      "/edit",
      { slug: "index", content: "---\nprotection: open\n---\nlol\n" },
      anon("203.0.113.7"),
    );
    const [bad] = (await w.get<{ revisions: { sha: string }[] }>("/history?slug=index"))
      .body.revisions;

    expect((await w.post("/rollback", { sha: bad.sha }, w.alice)).status).toBe(200);
    expect(w.gh.file(w.repo, "content/index.md")).toBe(good);
  });

  it("the review queue only shows the wiki's own pending edits", async () => {
    const w = await ownedWiki();
    await w.call("POST", "/claim", { as: w.bob, body: { name: "garden" } });
    await w.post("/edit", { slug: "soup", content: "# Soup\n" }, anon("203.0.113.7"));

    const mine = await w.get<{ pending: unknown[] }>("/pending");
    const theirs = await w.call<{ pending: unknown[] }>("GET", "/pending", {
      repo: `${PLATFORM_ORG}/garden`,
    });
    expect(mine.body.pending).toHaveLength(1);
    expect(theirs.body.pending).toHaveLength(0);
  });
});
