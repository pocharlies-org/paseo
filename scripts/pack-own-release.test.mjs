import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { assertNoOfficialRenamedPackages, stageProductionClosure } from "./pack-own-release.mjs";

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

// A synthetic repo: own cli -> own server -> own protocol + third (with a nested version
// conflict) + a transitive third-party dep. The real tree is flat with occasional nests;
// this fixture exercises both layouts.
function createClosureFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-pack-closure-"));
  writeJson(path.join(root, "packages/cli/package.json"), {
    name: "@pocharlies/cli",
    version: "1.2.3",
    dependencies: { "@pocharlies/server": "1.2.3", commander: "^12.0.0" },
  });
  writeFileSync(path.join(root, "packages/cli/index.js"), "// cli\n");
  writeJson(path.join(root, "packages/server/package.json"), {
    name: "@pocharlies/server",
    version: "1.2.3",
    dependencies: { "@pocharlies/protocol": "1.2.3", third: "^2.0.0" },
  });
  writeFileSync(path.join(root, "packages/server/index.js"), "// server\n");
  // npm ci links workspace packages into the root node_modules (junctions/symlinks):
  // the resolver must find them through that link, like the real tree.
  const workspaceLink = path.join(root, "node_modules/@pocharlies/server");
  mkdirSync(path.dirname(workspaceLink), { recursive: true });
  symlinkSync(path.join(root, "packages/server"), workspaceLink, "junction");
  writeJson(path.join(root, "node_modules/@pocharlies/protocol/package.json"), {
    name: "@pocharlies/protocol",
    version: "1.2.3",
    dependencies: { zod: "^4.0.0", shared: "^1.0.0" },
  });
  writeJson(path.join(root, "node_modules/commander/package.json"), { name: "commander" });
  writeJson(path.join(root, "node_modules/third/package.json"), {
    name: "third",
    version: "2.0.0",
    dependencies: { shared: "^1.0.0" },
  });
  // The hoisted "shared" is 1.0.0; "third" nests a conflicting 1.9.0, like the real tree.
  writeJson(path.join(root, "node_modules/shared/package.json"), {
    name: "shared",
    version: "1.0.0",
  });
  writeJson(path.join(root, "node_modules/third/node_modules/shared/package.json"), {
    name: "shared",
    version: "1.9.0",
  });
  writeJson(path.join(root, "node_modules/zod/package.json"), { name: "zod" });
  return root;
}

test("stageProductionClosure copies the full production closure, flat plus nests", () => {
  const root = createClosureFixture();
  try {
    const staging = stageProductionClosure(root, path.join(root, "packages/cli"));
    try {
      const staged = JSON.parse(readFileSync(path.join(staging, "package.json"), "utf8"));
      assert.equal(staged.name, "@pocharlies/cli");
      assert.deepEqual([...staged.bundleDependencies].sort(), [
        "@pocharlies/protocol",
        "@pocharlies/server",
        "commander",
        "shared",
        "third",
        "zod",
      ]);
      const nm = path.join(staging, "node_modules");
      for (const name of [
        "@pocharlies/server",
        "@pocharlies/protocol",
        "commander",
        "third",
        "shared",
        "zod",
      ]) {
        assert.ok(existsSync(path.join(nm, ...name.split("/"), "package.json")), `${name} staged`);
      }
      // The conflict nest rides inside "third".
      assert.equal(
        JSON.parse(readFileSync(path.join(nm, "third/node_modules/shared/package.json"), "utf8"))
          .version,
        "1.9.0",
      );
    } finally {
      rmSync(path.dirname(staging), { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stageProductionClosure fails when a production dependency is not installed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-pack-closure-"));
  try {
    writeJson(path.join(root, "packages/cli/package.json"), {
      name: "@pocharlies/cli",
      dependencies: { "missing-dep": "^1.0.0" },
    });
    assert.throws(
      () => stageProductionClosure(root, path.join(root, "packages/cli")),
      /Cannot resolve production dependency "missing-dep"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertNoOfficialRenamedPackages fails closed on official renamed packages in the closure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-pack-guard-"));
  try {
    const nm = path.join(dir, "node_modules");
    writeJson(path.join(nm, "@getpaseo/server/package.json"), { name: "@getpaseo/server" });
    assert.throws(
      () => assertNoOfficialRenamedPackages(dir),
      /run set-distribution\.mjs --own --rewrite-packages/,
    );
    rmSync(path.join(nm, "@getpaseo"), { recursive: true, force: true });
    // Packages outside the four (highlight) are allowed to ride in the closure.
    writeJson(path.join(nm, "@getpaseo/highlight/package.json"), { name: "@getpaseo/highlight" });
    assertNoOfficialRenamedPackages(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
