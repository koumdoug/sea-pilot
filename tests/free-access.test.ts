import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function load(ids: string) {
  vi.stubEnv("FREE_ACCESS_USER_IDS", ids);
  vi.resetModules();
  return import("@/lib/free-access");
}

describe("accès propriétaire gratuit", () => {
  it("n'accorde rien par défaut (variable vide)", async () => {
    expect((await load("")).isFreeOwner("u1", "owner")).toBe(false);
  });
  it("exige l'identifiant listé ET le rôle propriétaire", async () => {
    const m = await load(" u1 , u2 ");
    expect(m.isFreeOwner("u1", "owner")).toBe(true);
    expect(m.isFreeOwner("u2", "owner")).toBe(true);
    expect(m.isFreeOwner("u1", "admin")).toBe(false);
    expect(m.isFreeOwner("u3", "owner")).toBe(false);
  });
});
