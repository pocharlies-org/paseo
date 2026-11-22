// Integration test for the own CLI tarball (SC-5508 C3): install the self-contained own
// .tgz into an isolated npm prefix with no registry access and verify the daemon-side
// resolution lands on the OWN server, never @getpaseo/server.
//
// It consumes the tarballs produced by the own packaging flow (set-distribution.mjs --own
// --rewrite-packages, build, pack-own-release.mjs) and receives them via
// PASEO_OWN_CLI_TGZ / PASEO_OWN_SERVER_TGZ. It fails (never skips) when they are absent:
// a green run without the artifact is exactly the silent-official failure this guards.
//
// The same flow in CI: .github/workflows/own-release.yml.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const cliTarball = process.env.PASEO_OWN_CLI_TGZ;
const serverTarball = process.env.PASEO_OWN_SERVER_TGZ;
const OWN_SCOPE = "@pocharlies";

test("own cli tarball installs offline and the daemon resolves the own server", () => {
  if (!cliTarball || !serverTarball) {
    throw new Error(
      "PASEO_OWN_CLI_TGZ / PASEO_OWN_SERVER_TGZ not set: run the own packaging flow first " +
        "(set-distribution.mjs --own --rewrite-packages, build, pack-own-release.mjs)",
    );
  }
  const prefix = mkdtempSync(path.join(tmpdir(), "paseo-own-prefix-"));
  try {
    // --offline: npm may only use its cache, never the registry. A tarball that still
    // declared @getpaseo/* deps would fail here (404/ENOTCACHED), not silently install
    // the official server.
    execFileSync(
      "npm",
      [
        "install",
        "-g",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        cliTarball,
        serverTarball,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 240_000,
      },
    );

    const globalNodeModules = path.join(prefix, "lib", "node_modules");
    const ownCliDir = path.join(globalNodeModules, ...`${OWN_SCOPE}/cli`.split("/"));
    const ownServerDir = path.join(globalNodeModules, ...`${OWN_SCOPE}/server`.split("/"));
    assert.ok(existsSync(path.join(ownCliDir, "package.json")), "own cli installed in prefix");
    const ownServerPkg = JSON.parse(readFileSync(path.join(ownServerDir, "package.json"), "utf8"));
    assert.equal(ownServerPkg.name, `${OWN_SCOPE}/server`);

    // The whole point: the official server is nowhere in the installed tree.
    const offenders = [];
    const scan = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name === "node_modules") scan(full);
        else if (entry.isDirectory() && entry.name === "@getpaseo") offenders.push(full);
      }
    };
    scan(globalNodeModules);
    assert.deepEqual(offenders, [], "no @getpaseo packages in the installed tree");

    // local-daemon.ts resolves the server through DISTRIBUTION.npmServerPackage: from the
    // installed CLI, the configured own server resolves inside this prefix.
    const localDaemonJs = path.join(ownCliDir, "dist", "commands", "daemon", "local-daemon.js");
    assert.ok(existsSync(localDaemonJs), "compiled local-daemon.js shipped");
    const probe = path.join(prefix, "probe.mjs");
    writeFileSync(
      probe,
      `
      import { createRequire } from "node:module";
      const require = createRequire(${JSON.stringify(localDaemonJs)});
      const { DISTRIBUTION } = await import("file://" + require.resolve("${OWN_SCOPE}/protocol/distribution"));
      const resolved = require.resolve(DISTRIBUTION.npmServerPackage);
      if (!resolved.startsWith(${JSON.stringify(globalNodeModules)})) {
        throw new Error("resolved outside the isolated prefix: " + resolved);
      }
      if (resolved.includes("@getpaseo")) {
        throw new Error("resolved the official server: " + resolved);
      }
      // The server package's "exports" does not expose ./package.json, so read it by
      // walking up from the resolved main entry instead of require.resolve'ing it.
      const fs = require("node:fs");
      const pth = require("node:path");
      let serverRoot = pth.dirname(resolved);
      while (!fs.existsSync(pth.join(serverRoot, "package.json"))) {
        const parent = pth.dirname(serverRoot);
        if (parent === serverRoot) throw new Error("no package.json above " + resolved);
        serverRoot = parent;
      }
      const pkg = JSON.parse(fs.readFileSync(pth.join(serverRoot, "package.json"), "utf8"));
      if (pkg.name !== "${OWN_SCOPE}/server") throw new Error("wrong server package: " + pkg.name);
      process.stdout.write("own-server-ok");
      `,
    );
    const probeOut = execFileSync(process.execPath, [probe], { encoding: "utf8", timeout: 60_000 });
    assert.equal(probeOut.trim(), "own-server-ok");

    // The own build identity is baked in: the installed protocol carries the own channel.
    const cliRequire = createRequire(path.join(ownCliDir, "noop.js"));
    const distributionJs = cliRequire.resolve(`${OWN_SCOPE}/protocol/distribution`);
    const distributionSource = readFileSync(distributionJs, "utf8");
    assert.match(distributionSource, /githubOwner:\s*"pocharlies-org"/);
    assert.match(distributionSource, /npmServerPackage:\s*"@pocharlies\/server"/);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
