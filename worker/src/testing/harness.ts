import { vi } from "vitest";
import { withClientIp } from "../clientip";
import { signSession } from "../identity/auth";
import app from "../index";
import { MemoryKV } from "../store";
import type { Env } from "../types";
import { FakeGitHub } from "./fake-github";

// A hosted, multi-tenant Engine (the wikigit.org shape) wired to a FakeGitHub, plus
// a client that speaks to it the way the reader does. Journey tests drive the real
// router end to end; only GitHub is faked.

export const OPERATOR_REPO = "wikigit/flagship";
export const PLATFORM_ORG = "wikigit-tenants";
const SESSION_SECRET = "session-secret";

async function testPem(): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign"],
  );
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----`;
}
const PEM = testPem();

export interface Identity {
  token?: string;
  ip?: string;
  headers?: Record<string, string>;
}

export const anon = (ip: string): Identity => ({ ip });

export async function github(login: string, id = 1000): Promise<Identity> {
  return {
    token: await signSession(SESSION_SECRET, {
      login,
      id,
      avatar: `https://avatars.example/${login}`,
      provider: "github",
    }),
  };
}

export async function wikigit(handle: string, sub: string): Promise<Identity> {
  return {
    token: await signSession(SESSION_SECRET, {
      login: handle,
      id: 0,
      avatar: "",
      provider: "wikigit",
      sub,
    }),
  };
}

export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface Platform {
  gh: FakeGitHub;
  env: Env;
  call<T = Record<string, unknown>>(
    method: string,
    path: string,
    opts?: { as?: Identity; repo?: string; body?: unknown; viaBunServer?: boolean },
  ): Promise<Reply<T>>;
}

// The NDJSON publish stream collapses to its terminal event, so an edit reads
// like any other call: `done` → 200 + result, `error` → its status + message.
async function readReply(res: Response): Promise<Reply> {
  if (!res.headers.get("Content-Type")?.includes("ndjson"))
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  const events = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const last = events.at(-1);
  if (last?.type === "done") return { status: 200, body: last.result };
  return { status: last?.status ?? 500, body: { error: last?.error } };
}

export async function platform(overrides: Partial<Env> = {}): Promise<Platform> {
  const gh = new FakeGitHub();
  gh.createRepo(OPERATOR_REPO, { "content/index.md": "# Wikigit\n" });
  gh.platformOrgs.add(PLATFORM_ORG);
  gh.appInstalledOrgs.add(PLATFORM_ORG);
  vi.stubGlobal("fetch", gh.fetch);

  const pem = await PEM;
  const [owner, name] = OPERATOR_REPO.split("/");
  const env: Env = {
    HASH_SECRET: "hash-secret",
    SESSION_SECRET,
    REPO_OWNER: owner,
    REPO_NAME: name,
    BRANCH: "main",
    CONTENT_DIR: "content",
    ALLOWED_ORIGIN: "",
    POW_BITS: "0",
    MULTI_TENANT: "1",
    PLATFORM_HOST: "wikigit.org",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_PLATFORM_APP_ID: "2",
    GITHUB_PLATFORM_APP_PRIVATE_KEY: pem,
    PLATFORM_ORG,
    RATE_LIMIT: new MemoryKV(),
    ...overrides,
  };

  return {
    gh,
    env,
    async call(method, path, opts = {}) {
      const url = new URL(path, "https://api.wikigit.org");
      if (opts.repo) url.searchParams.set("repo", opts.repo);
      const headers: Record<string, string> = { ...opts.as?.headers };
      if (opts.as?.token) headers.Authorization = `Bearer ${opts.as.token}`;
      if (opts.as?.ip) headers["CF-Connecting-IP"] = opts.as.ip;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      const request = new Request(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      // What server.ts does in front of the router; the peer is the proxy's address.
      const res = await app.fetch(
        opts.viaBunServer ? withClientIp(request, "10.0.0.2") : request,
        env,
      );
      return readReply(res) as never;
    },
  };
}
