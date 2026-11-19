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

  it("reports the latest entry with its age", () => {
    vi.useFakeTimers({ now: 1_000 });
    vi.stubGlobal("localStorage", fakeStorage());
    writeCached("r:versions", "head1", { index: "s1" });
    vi.setSystemTime(31_000);
    expect(readLatest("r:versions")).toEqual({
      sha: "head1",
      age: 30_000,
      value: { index: "s1" },
    });
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
