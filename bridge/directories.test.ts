import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DirectoryService, directoryPath } from "./directories.ts";
import type { SessionRegistry } from "./sessions.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))); });
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "relay-dirs-")); dirs.push(root);
  let connected = true;
  const registry = { get: (name?: string) => !name || name === "default" ? { name: "default", engine: { current: () => ({ bridge: connected ? "connected" : "disconnected" }) } } : undefined } as unknown as SessionRegistry;
  return { root, registry, service: new DirectoryService(registry, [{ name: "Test", path: root }]), disconnect: () => { connected = false; } };
}
describe.skipIf(process.platform !== "linux")("safe host directories (real filesystem)", () => {
  test("lists roots/immediate directories with stable pagination and parent boundaries", async () => {
    const h = await harness(); for (const name of ["c", "b", "a"]) await mkdir(join(h.root, name));
    await writeFile(join(h.root, "file.txt"), "not listed"); await symlink(join(h.root, "a"), join(h.root, "link"));
    expect(await h.service.list()).toEqual({ roots: [{ name: "Test", path: h.root }] });
    const first = await h.service.list(undefined, { path: h.root, limit: 2 });
    expect(first).toMatchObject({ path: h.root, parentPath: null, directories: [{ name: "a", path: join(h.root, "a") }, { name: "b", path: join(h.root, "b") }] });
    expect("nextCursor" in first && first.nextCursor).toBeTruthy();
    const second = await h.service.list(undefined, { path: h.root, limit: 2, cursor: (first as any).nextCursor });
    expect(second).toMatchObject({ directories: [{ name: "c", path: join(h.root, "c") }], nextCursor: null });
    expect(await h.service.list(undefined, { path: join(h.root, "a") })).toMatchObject({ parentPath: h.root, directories: [] });
    await mkdir(join(h.root, "new"));
    await expect(h.service.list(undefined, { path: h.root, cursor: (first as any).nextCursor })).rejects.toMatchObject({ code: "directory_changed" });
  });
  test("validates existing/manual paths and rejects traversal, file and all symlink components", async () => {
    const h = await harness(); const dir = join(h.root, "real"); await mkdir(dir); await writeFile(join(h.root, "file"), "x");
    await symlink("/tmp", join(h.root, "escape")); await symlink(dir, join(h.root, "internal"));
    expect(await h.service.validate(undefined, dir + "/")).toEqual({ path: dir, valid: true, reason: null });
    expect(await h.service.validate(undefined, join(h.root, "missing"))).toMatchObject({ valid: false, reason: "not_found" });
    expect(await h.service.validate(undefined, join(h.root, "file"))).toMatchObject({ valid: false, reason: "not_directory" });
    expect(await h.service.validate(undefined, "/etc")).toMatchObject({ valid: false, reason: "outside_allowed_roots" });
    expect((await h.service.validate(undefined, join(h.root, "escape"))).valid).toBe(false);
    expect((await h.service.validate(undefined, join(h.root, "internal"))).valid).toBe(false);
    expect(() => directoryPath(h.root + "/../escape")).toThrow(); expect(() => directoryPath("relative")).toThrow();
  });
  test("creates one private child; concurrent/retried requests do not duplicate and mismatched ID conflicts", async () => {
    const h = await harness(); const body = { parentPath: h.root, name: "design", requestId: "r1" };
    const result = await Promise.all(Array.from({ length: 5 }, () => h.service.create(undefined, body)));
    expect(result.every((r) => r.created && r.path === join(h.root, "design"))).toBe(true);
    expect((await stat(join(h.root, "design"))).mode & 0o777).toBe(0o700);
    await expect(h.service.create(undefined, { ...body, name: "other" })).rejects.toMatchObject({ code: "request_id_conflict" });
    expect(await h.service.create(undefined, { ...body, requestId: "r2" })).toMatchObject({ created: false });
    const restart = new DirectoryService(h.registry, [{ name: "Test", path: h.root }]);
    expect(await restart.create(undefined, body)).toMatchObject({ created: false });
    await expect(restart.create(undefined, { ...body, name: "other" })).rejects.toMatchObject({ code: "request_id_conflict" });
  });
  test("files/symlinks conflict and unsafe names cannot modify unrelated directories", async () => {
    const h = await harness(); await writeFile(join(h.root, "file"), "unchanged"); await symlink("/tmp", join(h.root, "link"));
    for (const name of ["file", "link"]) await expect(h.service.create(undefined, { parentPath: h.root, name, requestId: name })).rejects.toMatchObject({ code: "existing_non_directory" });
    for (const name of ["..", ".", "a/b", "a\\b", "", "x\0", "a".repeat(256)]) await expect(h.service.create(undefined, { parentPath: h.root, name, requestId: "invalid" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(h.service.create(undefined, { parentPath: join(h.root, "link"), name: "nope", requestId: "escape" })).rejects.toBeDefined();
  });
  test("default no roots, overlapping roots and runtime selection fail closed", async () => {
    const h = await harness();
    expect(await new DirectoryService(h.registry, []).list()).toEqual({ roots: [] });
    await mkdir(join(h.root, "nested")); const service = new DirectoryService(h.registry, [{ name: "Outer", path: h.root }, { name: "Inner", path: join(h.root, "nested") }]);
    expect(await service.list(undefined, { path: join(h.root, "nested") })).toMatchObject({ parentPath: null });
    await expect(h.service.list("unknown")).rejects.toMatchObject({ code: "runtime_unknown" });
    h.disconnect(); await expect(h.service.list()).rejects.toMatchObject({ code: "runtime_unavailable" });
  });
  test("unreadable parent is rejected without creating a child", async () => {
    if (process.getuid?.() === 0) return;
    const h = await harness(); const parent = join(h.root, "locked"); await mkdir(parent); await chmod(parent, 0);
    try {
      expect(await h.service.validate(undefined, parent)).toMatchObject({ valid: false, reason: "not_accessible" });
      await expect(h.service.create(undefined, { parentPath: parent, name: "child", requestId: "r1" })).rejects.toMatchObject({ code: "not_accessible" });
    } finally { await chmod(parent, 0o700); }
  });
  test("root replacement with a symlink never redirects a later create", async () => {
    const h = await harness(); const outside = await mkdtemp(join(tmpdir(), "relay-outside-")); dirs.push(outside);
    const saved = h.root + "-saved"; dirs.push(saved); await rename(h.root, saved); await symlink(outside, h.root);
    await expect(h.service.create(undefined, { parentPath: h.root, name: "must-not-create", requestId: "r1" })).rejects.toMatchObject({ code: "root_unavailable" });
    await expect(stat(join(outside, "must-not-create"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
