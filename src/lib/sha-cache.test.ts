import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetCached, readCached, readLatest, writeCached } from "./sha-cache";

function fakeStorage(quota = Number.POSITIVE_INFINITY) {
  const m = new Map<string, string>();
  const used = () => [...m.values()].reduce((n, v) => n + v.length, 0);
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (used() - (m.get(k)?.length ?? 0) + v.length > quota)
        throw new DOMException("full", "QuotaExceededError");
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
    _map: m,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sha cache", () => {
  it("returns a value only for the sha it was stored at", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    writeCached("r:page", "aaa", { html: "<p>x</p>" });
    expect(readCached("r:page", "aaa")).toEqual({ html: "<p>x</p>" });
    expect(readCached("r:page", "bbb")).toBeUndefined();
  });

  it("hands back the latest entry whatever its sha", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    writeCached("r:page", "aaa", "A");
    writeCached("r:page", "bbb", "B");
    expect(readLatest("r:page")).toEqual({ sha: "bbb", value: "B" });
  });

  it("drops entries older than 7 days", () => {
    const day = 86_400_000;
    vi.useFakeTimers({ now: 0 });
    vi.stubGlobal("localStorage", fakeStorage());
    writeCached("r:page", "aaa", "A");
    vi.setSystemTime(7 * day);
    expect(readLatest("r:page")?.value).toBe("A");
    vi.setSystemTime(7 * day + 1);
    expect(readLatest("r:page")).toBeUndefined();
    expect(readCached("r:page", "aaa")).toBeUndefined();
  });

  it("forgets an entry", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    writeCached("r:versions", "head1", {});
    forgetCached("r:versions");
    expect(readLatest("r:versions")).toBeUndefined();
  });

  it("makes room by dropping its oldest entries when storage is full", () => {
    vi.useFakeTimers({ now: 0 });
    const store = fakeStorage(400);
    vi.stubGlobal("localStorage", store);
    store.setItem("someone-else", "keep me");
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(i * 1000);
      writeCached(`p${i}`, "s", "x".repeat(50));
    }
    writeCached("new", "s", "y".repeat(50));
    expect(readCached("new", "s")).toBe("y".repeat(50));
    expect(readCached("p0", "s")).toBeUndefined();
    expect(readCached("p3", "s")).toBe("x".repeat(50));
    expect(store.getItem("someone-else")).toBe("keep me");
  });

  it("degrades to a no-op when storage is unavailable or corrupt", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => writeCached("k", "s", 1)).not.toThrow();
    expect(readCached("k", "s")).toBeUndefined();
    expect(() => forgetCached("k")).not.toThrow();

    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    store.setItem("wikigit:c:k", "{not json");
    expect(readCached("k", "s")).toBeUndefined();
  });
});
