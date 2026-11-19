import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anon,
  github,
  OPERATOR_REPO,
  PLATFORM_ORG,
  platform,
  wikigit,
} from "../testing/harness";

afterEach(() => vi.unstubAllGlobals());

describe("journey: create a hosted wiki", () => {
  it("requires sign-in", async () => {
    const p = await platform();
    const res = await p.call("POST", "/claim", {
      as: anon("1.1.1.1"),
      body: { name: "recipes" },
    });
    expect(res.status).toBe(401);
    expect(p.gh.repos.has(`${PLATFORM_ORG}/recipes`)).toBe(false);
  });

  it("checks the name, provisions the repo, registers it, and serves it", async () => {
    const p = await platform();
    const alice = await github("alice");

    const before = await p.call("GET", "/tenant-available?name=recipes");
    expect(before.body).toEqual({ name: "recipes", available: true });

    const claim = await p.call("POST", "/claim", {
      as: alice,
      body: { name: "recipes", lane: "platform" },
    });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({
      repo: `${PLATFORM_ORG}/recipes`,
      lane: "platform",
      url: "https://recipes.wikigit.org",
    });

    const repo = `${PLATFORM_ORG}/recipes`;
    expect(p.gh.file(repo, "content/index.md")).toContain("# Recipes");
    expect(JSON.parse(p.gh.file(repo, "wikigit.json") ?? "{}")).toMatchObject({
      title: "Recipes",
    });
    const registry = p.gh.file(OPERATOR_REPO, ".wikigit/tenants.jsonl") ?? "";
    expect(JSON.parse(registry.trim())).toMatchObject({
      name: "recipes",
      repo,
      owner: "gh:alice",
      lane: "platform",
    });

    const after = await p.call("GET", "/tenant-available?name=recipes");
    expect(after.body).toMatchObject({ available: false, reason: "taken" });
    const resolved = await p.call("GET", "/resolve?host=recipes.wikigit.org");
    expect(resolved.body).toEqual({ name: "recipes", repo, lane: "platform" });

    const pages = await p.call("GET", "/pages", { repo });
    expect(pages.body).toEqual({ pages: ["index"] });
    const config = await p.call("GET", "/config", { repo });
    expect(config.body).toMatchObject({ config: { title: "Recipes" } });
    const version = await p.call<{ sha: string; versions: Record<string, string> }>(
      "GET",
      "/version",
      { repo },
    );
    expect(Object.keys(version.body.versions)).toEqual(["index"]);
  });

  it("makes the creator a maintainer of their new wiki", async () => {
    const p = await platform();
    const alice = await github("alice");
    await p.call("POST", "/claim", { as: alice, body: { name: "recipes" } });

    const me = await p.call("GET", "/whoami", {
      as: alice,
      repo: `${PLATFORM_ORG}/recipes`,
    });
    expect(me.body).toMatchObject({ author: "alice", tier: "maintainer" });
  });

  it("lets the creator change the wiki's settings", async () => {
    const p = await platform();
    const alice = await github("alice");
    await p.call("POST", "/claim", { as: alice, body: { name: "recipes" } });

    const repo = `${PLATFORM_ORG}/recipes`;
    const loaded = await p.call<{ config: Record<string, unknown> }>("GET", "/config", {
      repo,
    });
    const res = await p.call("POST", "/config", {
      as: alice,
      repo,
      body: { ...loaded.body.config, title: "Grandma's Recipes" },
    });
    expect(res.status).toBe(200);
  });

  it("publishes the creator's first edit live, not into a review queue", async () => {
    const p = await platform();
    const alice = await github("alice");
    await p.call("POST", "/claim", { as: alice, body: { name: "recipes" } });

    const repo = `${PLATFORM_ORG}/recipes`;
    const edit = await p.call("POST", "/edit", {
      as: alice,
      repo,
      body: { slug: "index", content: "# Recipes\n\nOur family cookbook.\n" },
    });
    expect(edit.body).toMatchObject({ live: true });
    expect(p.gh.file(repo, "content/index.md")).toContain("family cookbook");
  });

  it("makes an email (Wikigit account) creator a maintainer too", async () => {
    const p = await platform();
    const bob = await wikigit("bob", "sub-123");
    const claim = await p.call("POST", "/claim", { as: bob, body: { name: "garden" } });
    expect(claim.status).toBe(200);

    const me = await p.call("GET", "/whoami", {
      as: bob,
      repo: `${PLATFORM_ORG}/garden`,
    });
    expect(me.body).toMatchObject({ tier: "maintainer" });
  });

  it("refuses taken, reserved and malformed names without creating a repo", async () => {
    const p = await platform();
    const alice = await github("alice");
    await p.call("POST", "/claim", { as: alice, body: { name: "recipes" } });

    for (const name of ["recipes", "api", "Bad_Name", "-x", ""]) {
      const res = await p.call("POST", "/claim", { as: alice, body: { name } });
      expect(res.status, name).toBe(409);
    }
    expect([...p.gh.repos.keys()].filter((r) => r.startsWith(PLATFORM_ORG))).toEqual([
      `${PLATFORM_ORG}/recipes`,
    ]);
  });

  it("treats an uppercase name as its lowercase address", async () => {
    const p = await platform();
    const res = await p.call("POST", "/claim", {
      as: await github("alice"),
      body: { name: "Recipes" },
    });
    expect(res.body).toMatchObject({
      name: "recipes",
      url: "https://recipes.wikigit.org",
    });
  });

  it("caps hosted wikis per owner", async () => {
    const p = await platform({ MAX_WIKIS_PER_OWNER: "2" });
    const alice = await github("alice");
    for (const name of ["one", "two"])
      expect(
        (await p.call("POST", "/claim", { as: alice, body: { name } })).status,
      ).toBe(200);
    const third = await p.call("POST", "/claim", {
      as: alice,
      body: { name: "three" },
    });
    expect(third.status).toBe(429);
    const other = await p.call("POST", "/claim", {
      as: await github("carol", 2),
      body: { name: "three" },
    });
    expect(other.status).toBe(200);
  });

  it("is paused by the operator kill-switch", async () => {
    const p = await platform({ PROVISION_PAUSED: "1" });
    const res = await p.call("POST", "/claim", {
      as: await github("alice"),
      body: { name: "recipes" },
    });
    expect(res.status).toBe(503);
  });

  it("keeps two new wikis' content apart", async () => {
    const p = await platform();
    const alice = await github("alice");
    await p.call("POST", "/claim", { as: alice, body: { name: "one" } });
    await p.call("POST", "/claim", { as: alice, body: { name: "two" } });

    p.gh.push(`${PLATFORM_ORG}/one`, { "content/only-in-one.md": "# Only in one\n" });
    const one = await p.call("GET", "/pages", { repo: `${PLATFORM_ORG}/one` });
    const two = await p.call("GET", "/pages", { repo: `${PLATFORM_ORG}/two` });
    expect(one.body).toEqual({ pages: ["index", "only-in-one"] });
    expect(two.body).toEqual({ pages: ["index"] });
  });
});

describe("journey: connect your own GitHub repo", () => {
  it("refuses a repo the app isn't installed on", async () => {
    const p = await platform();
    p.gh.createRepo(
      "alice/notes",
      { "content/index.md": "# Notes\n" },
      { installed: false },
    );
    const res = await p.call("POST", "/claim", {
      as: await github("alice"),
      body: { name: "notes", lane: "byo", repo: "alice/notes" },
    });
    expect(res.status).toBe(400);
    expect(p.gh.file(OPERATOR_REPO, ".wikigit/tenants.jsonl")).toBeUndefined();
  });

  it("registers an installed repo and serves its existing content", async () => {
    const p = await platform();
    p.gh.createRepo("alice/notes", {
      "content/index.md": "# Notes\n",
      "content/ideas.md": "# Ideas\n",
    });
    const alice = await github("alice");
    const claim = await p.call("POST", "/claim", {
      as: alice,
      body: { name: "notes", lane: "byo", repo: "alice/notes" },
    });
    expect(claim.body).toMatchObject({ repo: "alice/notes", lane: "byo" });

    const resolved = await p.call("GET", "/resolve?host=notes.wikigit.org");
    expect(resolved.body).toMatchObject({ repo: "alice/notes" });
    const pages = await p.call("GET", "/pages", { repo: "alice/notes" });
    expect(pages.body).toEqual({ pages: ["ideas", "index"] });
    const me = await p.call("GET", "/whoami", { as: alice, repo: "alice/notes" });
    expect(me.body).toMatchObject({ tier: "maintainer" });
  });

  it("doesn't count connected repos against the hosted quota", async () => {
    const p = await platform({ MAX_WIKIS_PER_OWNER: "1" });
    const alice = await github("alice");
    p.gh.createRepo("alice/notes", { "content/index.md": "# Notes\n" });
    await p.call("POST", "/claim", {
      as: alice,
      body: { name: "notes", lane: "byo", repo: "alice/notes" },
    });
    const hosted = await p.call("POST", "/claim", {
      as: alice,
      body: { name: "hosted" },
    });
    expect(hosted.status).toBe(200);
  });
});
