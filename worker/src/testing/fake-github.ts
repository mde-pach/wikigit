import { createHash } from "node:crypto";

// A stateful, in-memory stand-in for the slice of GitHub the Engine talks to:
// REST (contents, refs, pulls, commits, trees, compare, installs, repo create),
// the pending-review GraphQL query, and raw.githubusercontent.com. Unlike the
// per-test fetch stubs elsewhere, state carries across calls, so a test can walk a
// whole user journey (claim → edit → review → read back) and assert on the repo.
//
// Fidelity limits, on purpose: merges are file-level 3-way (two edits to the same
// file conflict even when GitHub would line-merge them), and a squash merge keeps
// the head commit's author.

type Tree = Map<string, string>;

interface Author {
  name: string;
  email: string;
  date: string;
}

interface Commit {
  sha: string;
  tree: Tree;
  parents: string[];
  author: Author;
  message: string;
}

interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  createdAt: string;
}

export interface FakeRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  pulls: Pull[];
  comments: { on: string; body: string }[];
  installed: boolean;
}

export interface RequestLog {
  method: string;
  url: string;
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

export function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const err = (status: number, message: string) => Response.json({ message }, { status });

function lineDiff(before: string | undefined, after: string | undefined) {
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push(`+${b[j++]}`);
    } else {
      lines.push(`-${a[i++]}`);
    }
  }
  const additions = lines.filter((l) => l.startsWith("+")).length;
  const deletions = lines.filter((l) => l.startsWith("-")).length;
  const patch = `@@ -1,${a.length} +1,${b.length} @@\n${lines.join("\n")}`;
  return { additions, deletions, patch };
}

function treeDiff(from: Tree, to: Tree) {
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  return paths
    .filter((p) => from.get(p) !== to.get(p))
    .map((filename) => {
      const before = from.get(filename);
      const after = to.get(filename);
      const status =
        before === undefined ? "added" : after === undefined ? "removed" : "modified";
      return { filename, status, ...lineDiff(before, after) };
    });
}

export class FakeGitHub {
  repos = new Map<string, FakeRepo>();
  // Orgs where the content App is installed org-wide: repos created there are served.
  appInstalledOrgs = new Set<string>();
  platformOrgs = new Set<string>();
  log: RequestLog[] = [];
  unhandled: RequestLog[] = [];
  private seq = 0;
  private prSeq = 0;

  private nextSha(): string {
    this.seq++;
    return createHash("sha1").update(`commit-${this.seq}`).digest("hex");
  }

  private now(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.seq * 60_000).toISOString();
  }

  createRepo(
    slug: string,
    files: Record<string, string> = {},
    opts: { installed?: boolean; author?: Author } = {},
  ): FakeRepo {
    const [owner, name] = slug.split("/");
    const sha = this.nextSha();
    const repo: FakeRepo = {
      owner,
      name,
      defaultBranch: "main",
      branches: new Map([["main", sha]]),
      commits: new Map(),
      pulls: [],
      comments: [],
      installed: opts.installed ?? true,
    };
    repo.commits.set(sha, {
      sha,
      tree: new Map(Object.entries(files)),
      parents: [],
      author: opts.author ?? {
        name: "seed",
        email: "seed@example.invalid",
        date: this.now(),
      },
      message: "Initial commit",
    });
    this.repos.set(slug, repo);
    return repo;
  }

  repo(slug: string): FakeRepo {
    const r = this.repos.get(slug);
    if (!r) throw new Error(`fake: no repo ${slug}`);
    return r;
  }

  file(slug: string, path: string, ref = "main"): string | undefined {
    const repo = this.repo(slug);
    return this.treeAt(repo, ref)?.get(path);
  }

  history(slug: string, ref = "main"): Commit[] {
    const repo = this.repo(slug);
    const out: Commit[] = [];
    let sha: string | undefined = this.resolve(repo, ref);
    while (sha) {
      const c = repo.commits.get(sha) as Commit;
      out.push(c);
      sha = c.parents[0];
    }
    return out;
  }

  openPulls(slug: string): Pull[] {
    return this.repo(slug).pulls.filter((p) => p.state === "open");
  }

  // Simulate a commit landing outside the Engine (a git push, a github.com edit).
  push(
    slug: string,
    files: Record<string, string | null>,
    message = "external push",
    branch = "main",
  ): string {
    const repo = this.repo(slug);
    const tree = new Map(this.treeAt(repo, branch));
    for (const [p, c] of Object.entries(files)) {
      if (c === null) tree.delete(p);
      else tree.set(p, c);
    }
    return this.commit(repo, branch, tree, message, {
      name: "outsider",
      email: "outsider@example.invalid",
      date: this.now(),
    });
  }

  private resolve(repo: FakeRepo, ref: string): string | undefined {
    if (repo.branches.has(ref)) return repo.branches.get(ref);
    if (repo.commits.has(ref)) return ref;
    return undefined;
  }

  private treeAt(repo: FakeRepo, ref: string): Tree | undefined {
    const sha = this.resolve(repo, ref);
    return sha ? repo.commits.get(sha)?.tree : undefined;
  }

  private commit(
    repo: FakeRepo,
    branch: string,
    tree: Tree,
    message: string,
    author: Author,
  ): string {
    const parent = repo.branches.get(branch);
    const sha = this.nextSha();
    repo.commits.set(sha, {
      sha,
      tree,
      parents: parent ? [parent] : [],
      author: { ...author, date: this.now() },
      message,
    });
    repo.branches.set(branch, sha);
    return sha;
  }

  private ancestors(repo: FakeRepo, sha: string): string[] {
    const seen: string[] = [];
    const queue = [sha];
    while (queue.length) {
      const s = queue.shift() as string;
      if (seen.includes(s)) continue;
      seen.push(s);
      queue.push(...(repo.commits.get(s)?.parents ?? []));
    }
    return seen;
  }

  private mergeBase(repo: FakeRepo, a: string, b: string): string | undefined {
    const ofB = new Set(this.ancestors(repo, b));
    return this.ancestors(repo, a).find((s) => ofB.has(s));
  }

  private repoFromPath(parts: string[]): FakeRepo | undefined {
    return this.repos.get(`${parts[0]}/${parts[1]}`);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const method = (init.method ?? "GET").toUpperCase();
    const entry = { method, url: url.toString() };
    this.log.push(entry);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const accept = new Headers(init.headers).get("Accept") ?? "";
    let res: Response | undefined;
    if (url.origin === RAW) res = this.raw(url);
    else if (url.origin === API && url.pathname === "/graphql")
      res = this.graphql(body);
    else if (url.origin === API) res = this.rest(method, url, body, accept);
    if (res) return res;
    this.unhandled.push(entry);
    return err(501, `fake github: unhandled ${method} ${url}`);
  };

  private raw(url: URL): Response {
    const [owner, name, branch, ...rest] = url.pathname.slice(1).split("/");
    const repo = this.repos.get(`${owner}/${name}`);
    const content = repo && this.treeAt(repo, branch)?.get(rest.join("/"));
    return content === undefined
      ? new Response("404: Not Found", { status: 404 })
      : new Response(content);
  }

  private graphql(body: { query: string; variables: Record<string, string> }) {
    if (!body.query.includes("pullRequests")) return undefined;
    const { owner, name, base } = body.variables;
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) return Response.json({ errors: [{ message: "Could not resolve" }] });
    const nodes = repo.pulls
      .filter((p) => p.state === "open" && p.base === base)
      .reverse()
      .map((p) => ({
        number: p.number,
        title: p.title,
        createdAt: p.createdAt,
        headRefName: p.head,
        files: {
          nodes: this.pullFiles(repo, p).map((f) => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
          })),
        },
      }));
    return Response.json({ data: { repository: { pullRequests: { nodes } } } });
  }

  private pullFiles(repo: FakeRepo, p: Pull) {
    const head = repo.branches.get(p.head);
    const baseHead = repo.branches.get(p.base);
    if (!head || !baseHead) return [];
    const mb = this.mergeBase(repo, head, baseHead) as string;
    return treeDiff(
      repo.commits.get(mb)?.tree as Tree,
      repo.commits.get(head)?.tree as Tree,
    );
  }

  private pullJson(repo: FakeRepo, p: Pull) {
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      merged: p.merged,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${p.number}`,
      head: { ref: p.head, sha: repo.branches.get(p.head) ?? null },
      base: { ref: p.base },
    };
  }

  private rest(
    method: string,
    url: URL,
    body: Record<string, unknown>,
    accept: string,
  ): Response | undefined {
    const path = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    const tokenMint = path.match(/^\/app\/installations\/([^/]+)\/access_tokens$/);
    if (tokenMint && method === "POST")
      return Response.json(
        {
          token: `ghs_fake_${tokenMint[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { status: 201 },
      );

    const orgInstall = path.match(/^\/orgs\/([^/]+)\/installation$/);
    if (orgInstall)
      return this.platformOrgs.has(orgInstall[1])
        ? Response.json({ id: 9000 })
        : err(404, "Not Found");

    const orgRepos = path.match(/^\/orgs\/([^/]+)\/repos$/);
    if (orgRepos && method === "POST") {
      const slug = `${orgRepos[1]}/${body.name}`;
      if (this.repos.has(slug)) return err(422, "name already exists on this account");
      const files: Record<string, string> = body.auto_init
        ? { "README.md": `# ${body.name}\n` }
        : {};
      this.createRepo(slug, files, {
        installed: this.appInstalledOrgs.has(orgRepos[1]),
      });
      return Response.json({ full_name: slug }, { status: 201 });
    }

    const m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/);
    if (!m) return undefined;
    const repo = this.repoFromPath([m[1], m[2]]);
    const rest = m[3];

    if (rest === "installation")
      return repo?.installed ? Response.json({ id: 4242 }) : err(404, "Not Found");
    if (!repo) return err(404, "Not Found");

    if (rest.startsWith("contents/"))
      return this.contents(repo, method, rest.slice(9), q, body);

    const getRef = rest.match(/^git\/ref\/heads\/(.+)$/);
    if (getRef && method === "GET") {
      const sha = repo.branches.get(getRef[1]);
      return sha ? Response.json({ object: { sha } }) : err(404, "Not Found");
    }
    if (rest === "git/refs" && method === "POST") {
      const ref = String(body.ref).replace(/^refs\/heads\//, "");
      if (repo.branches.has(ref)) return err(422, "Reference already exists");
      repo.branches.set(ref, String(body.sha));
      return Response.json({ object: { sha: body.sha } }, { status: 201 });
    }
    const delRef = rest.match(/^git\/refs\/heads\/(.+)$/);
    if (delRef && method === "DELETE") {
      if (!repo.branches.delete(delRef[1])) return err(422, "Reference does not exist");
      return new Response(null, { status: 204 });
    }

    const trees = rest.match(/^git\/trees\/(.+)$/);
    if (trees) {
      const tree = this.treeAt(repo, trees[1]);
      if (!tree) return err(404, "Not Found");
      return Response.json({
        tree: [...tree]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([p, c]) => ({ path: p, type: "blob", sha: blobSha(c) })),
      });
    }

    if (rest === "pulls" && method === "GET") {
      const head = q.get("head")?.split(":").slice(1).join(":");
      const state = q.get("state") ?? "open";
      return Response.json(
        repo.pulls
          .filter((p) => (head ? p.head === head : true))
          .filter((p) => state === "all" || p.state === state)
          .map((p) => this.pullJson(repo, p)),
      );
    }
    if (rest === "pulls" && method === "POST") {
      const head = String(body.head);
      const base = String(body.base);
      if (!repo.branches.has(head)) return err(422, "head invalid");
      if (repo.branches.get(head) === repo.branches.get(base))
        return err(422, "No commits between base and head");
      if (repo.pulls.some((p) => p.head === head && p.state === "open"))
        return err(422, "A pull request already exists");
      const pull: Pull = {
        number: ++this.prSeq,
        head,
        base,
        title: String(body.title),
        body: String(body.body ?? ""),
        state: "open",
        merged: false,
        createdAt: this.now(),
      };
      repo.pulls.push(pull);
      return Response.json(this.pullJson(repo, pull), { status: 201 });
    }
    const pullM = rest.match(/^pulls\/(\d+)(\/(merge|files))?$/);
    if (pullM) {
      const pull = repo.pulls.find((p) => p.number === Number(pullM[1]));
      if (!pull) return err(404, "Not Found");
      if (pullM[3] === "files") return Response.json(this.pullFiles(repo, pull));
      if (pullM[3] === "merge" && method === "PUT") return this.merge(repo, pull, body);
      if (method === "PATCH") {
        if (body.state === "closed") pull.state = "closed";
        return Response.json(this.pullJson(repo, pull));
      }
      return Response.json(this.pullJson(repo, pull));
    }

    const issueComment = rest.match(/^(issues\/\d+|commits\/[0-9a-f]+)\/comments$/);
    if (issueComment && method === "POST") {
      repo.comments.push({ on: issueComment[1], body: String(body.body) });
      return Response.json({ id: repo.comments.length }, { status: 201 });
    }

    if (rest === "commits" && method === "GET") return this.listCommits(repo, q);
    const oneCommit = rest.match(/^commits\/(.+)$/);
    if (oneCommit) {
      const sha = this.resolve(repo, oneCommit[1]);
      if (!sha) return err(404, "No commit found");
      if (accept.includes("sha")) return new Response(sha);
      const c = repo.commits.get(sha) as Commit;
      const parentTree = c.parents[0]
        ? (repo.commits.get(c.parents[0])?.tree as Tree)
        : new Map();
      const files = treeDiff(parentTree, c.tree);
      return Response.json({
        ...this.commitJson(c),
        files,
        stats: {
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
        },
      });
    }

    const cmp = rest.match(/^compare\/(.+)\.\.\.(.+)$/);
    if (cmp) {
      const a = this.treeAt(repo, cmp[1]);
      const b = this.treeAt(repo, cmp[2]);
      if (!a || !b) return err(404, "Not Found");
      return Response.json({ files: treeDiff(a, b) });
    }
    return undefined;
  }

  private commitJson(c: Commit) {
    return {
      sha: c.sha,
      parents: c.parents.map((sha) => ({ sha })),
      commit: { author: c.author, message: c.message },
    };
  }

  private listCommits(repo: FakeRepo, q: URLSearchParams): Response {
    const start = this.resolve(repo, q.get("sha") ?? repo.defaultBranch);
    if (!start) return err(404, "Not Found");
    const path = q.get("path");
    const author = q.get("author");
    const all: Commit[] = [];
    let sha: string | undefined = start;
    while (sha) {
      const c = repo.commits.get(sha) as Commit;
      const parentTree = c.parents[0]
        ? (repo.commits.get(c.parents[0])?.tree as Tree)
        : new Map<string, string>();
      const touched =
        !path ||
        treeDiff(parentTree, c.tree).some(
          (f) => f.filename === path || f.filename.startsWith(`${path}/`),
        );
      if (touched && (!author || c.author.email === author)) all.push(c);
      sha = c.parents[0];
    }
    const perPage = Number(q.get("per_page") ?? 30);
    const page = Number(q.get("page") ?? 1);
    const last = Math.max(1, Math.ceil(all.length / perPage));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers = new Headers();
    if (last > 1) {
      const link = new URL(`${API}/repos/${repo.owner}/${repo.name}/commits`);
      for (const [k, v] of q) link.searchParams.set(k, v);
      link.searchParams.set("page", String(last));
      headers.set("Link", `<${link}>; rel="last"`);
    }
    return Response.json(
      slice.map((c) => this.commitJson(c)),
      { headers },
    );
  }

  private contents(
    repo: FakeRepo,
    method: string,
    path: string,
    q: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    if (method === "GET") {
      const content = this.treeAt(repo, q.get("ref") ?? repo.defaultBranch)?.get(path);
      if (content === undefined) return err(404, "Not Found");
      return Response.json({ path, sha: blobSha(content), content: b64(content) });
    }
    const branch = String(body.branch ?? repo.defaultBranch);
    const tree = this.treeAt(repo, branch);
    if (!tree) return err(404, "Branch not found");
    const existing = tree.get(path);
    const author = (body.author ?? body.committer) as Author;
    const next = new Map(tree);
    if (method === "PUT") {
      if (existing !== undefined && !body.sha)
        return err(422, `Invalid request.\n\n"sha" wasn't supplied.`);
      if (existing !== undefined && body.sha !== blobSha(existing))
        return err(409, `${path} does not match ${body.sha}`);
      next.set(path, unb64(String(body.content)));
    } else if (method === "DELETE") {
      if (existing === undefined) return err(404, "Not Found");
      if (body.sha !== blobSha(existing))
        return err(409, `${path} does not match ${body.sha}`);
      next.delete(path);
    } else {
      return err(405, "Method not allowed");
    }
    const sha = this.commit(repo, branch, next, String(body.message), author);
    const content = next.get(path);
    return Response.json(
      {
        content: content === undefined ? null : { path, sha: blobSha(content) },
        commit: { sha },
      },
      { status: existing === undefined ? 201 : 200 },
    );
  }

  private merge(repo: FakeRepo, pull: Pull, body: Record<string, unknown>): Response {
    if (pull.state !== "open") return err(405, "Pull Request is not mergeable");
    const head = repo.branches.get(pull.head);
    const baseHead = repo.branches.get(pull.base);
    if (!head || !baseHead) return err(405, "Pull Request is not mergeable");
    const mb = this.mergeBase(repo, head, baseHead) as string;
    const base = repo.commits.get(mb)?.tree as Tree;
    const ours = repo.commits.get(baseHead)?.tree as Tree;
    const theirs = repo.commits.get(head)?.tree as Tree;
    const merged = new Map<string, string>();
    for (const p of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
      const [b, o, t] = [base.get(p), ours.get(p), theirs.get(p)];
      let v: string | undefined;
      if (t === b) v = o;
      else if (o === b || o === t) v = t;
      else return err(405, "Pull Request is not mergeable");
      if (v !== undefined) merged.set(p, v);
    }
    const headCommit = repo.commits.get(head) as Commit;
    const sha = this.commit(
      repo,
      pull.base,
      merged,
      String(body.commit_title ?? pull.title),
      headCommit.author,
    );
    pull.state = "closed";
    pull.merged = true;
    return Response.json({
      sha,
      merged: true,
      message: "Pull Request successfully merged",
    });
  }
}
