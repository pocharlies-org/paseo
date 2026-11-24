// Packaging-time tool (run after `set-distribution.mjs --own --rewrite-packages` and the
// build): assemble each own release package into a staging directory whose node_modules
// holds its FULL production closure, and `npm pack` it. The resulting tarball installs
// with `npm install -g <tgz>` without resolving anything against the public registry —
// that is the point: an own daemon must never pull the official @getpaseo/* server.
//
// The closure is walked from the repo's own resolved tree (npm ci already flattened it):
// each dependency is resolved the way Node would from the consumer's directory (walking
// up node_modules chains), copied flat into staging, and nested only where the repo itself
// nests a conflicting version. bundleDependencies lists the staged top-level packages so
// npm pack includes them and npm install extracts them without any registry lookup.
//
// Platform note: native/optional dependencies are bundled as installed, so the tarball
// matches the architecture of the machine that packs it. Pack on the runner architecture
// that matches the target host.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import { OWN_RENAMED_OFFICIAL_NAMES } from "./set-distribution.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Resolve a dependency the way Node would from consumerDir: walk up each ancestor's
// node_modules. Returns { dir, nestedUnder } where nestedUnder is the consumer's own
// node_modules (the repo nests a conflicting version there) or null (hoisted at root).
function resolveDependencyDir(consumerDir, name, repoRoot) {
  let current = consumerDir;
  while (true) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return { dir: candidate, nestedUnder: current === consumerDir ? current : null };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
    if (current.length < repoRoot.length) return null;
  }
}

function copyPackageDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // The consumer's OWN node_modules holds its resolutions (walked separately into
    // staging); a package's nested node_modules (conflict resolutions deeper in its own
    // subtree) must ride along with it.
    if (entry.name === "node_modules") continue;
    fs.cpSync(path.join(from, entry.name), path.join(to, entry.name), { recursive: true });
  }
}

// Build the staging tree for one release package: copy the (renamed, built) package dir,
// then walk its production dependency graph copying every resolved package into
// staging/node_modules. Returns the staging directory (caller packs and removes it).
export function stageProductionClosure(repoRoot, packageDir) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-own-pack-"));
  const stagingRoot = path.join(staging, "package");
  copyPackageDir(packageDir, stagingRoot);

  const copied = new Map(); // name -> { version, stagingDir }
  const queue = []; // { name, consumerRepoDir, consumerStagingDir }

  const enqueueDeps = (pkgJsonPath, consumerRepoDir, consumerStagingDir) => {
    const pkg = readJson(pkgJsonPath);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name, consumerRepoDir, consumerStagingDir });
    }
  };
  enqueueDeps(path.join(packageDir, "package.json"), packageDir, stagingRoot);

  const seenRequests = new Set();
  while (queue.length > 0) {
    const { name, consumerRepoDir, consumerStagingDir } = queue.shift();
    const requestKey = `${consumerRepoDir}::${name}`;
    if (seenRequests.has(requestKey)) continue;
    seenRequests.add(requestKey);

    const resolved = resolveDependencyDir(consumerRepoDir, name, repoRoot);
    if (!resolved) {
      throw new Error(
        `Cannot resolve production dependency "${name}" of ${consumerRepoDir} — run npm ci and the build first`,
      );
    }
    const resolvedPkg = readJson(path.join(resolved.dir, "package.json"));
    const version = resolvedPkg.version ?? "0.0.0";

    const existing = copied.get(name);
    if (existing) {
      if (existing.version === version) continue; // already staged at this version
      // Version conflict: nest under the requesting consumer, like the repo tree does.
      const nested = path.join(consumerStagingDir, "node_modules", ...name.split("/"));
      if (fs.existsSync(path.join(nested, "package.json"))) continue;
      copyPackageDir(resolved.dir, nested);
      enqueueDeps(path.join(nested, "package.json"), resolved.dir, nested);
      continue;
    }

    const dest = path.join(stagingRoot, "node_modules", ...name.split("/"));
    copyPackageDir(resolved.dir, dest);
    copied.set(name, { version, stagingDir: dest });
    enqueueDeps(path.join(dest, "package.json"), resolved.dir, dest);
  }

  // bundleDependencies must name the packages npm pack should embed; nested copies ride
  // inside their parent's directory.
  const staged = readJson(path.join(stagingRoot, "package.json"));
  const topLevel = new Set();
  const nodeModulesRoot = path.join(stagingRoot, "node_modules");
  if (fs.existsSync(nodeModulesRoot)) {
    for (const entry of fs.readdirSync(nodeModulesRoot)) {
      if (entry.startsWith("@")) {
        for (const scoped of fs.readdirSync(path.join(nodeModulesRoot, entry))) {
          topLevel.add(`${entry}/${scoped}`);
        }
      } else if (fs.existsSync(path.join(nodeModulesRoot, entry, "package.json"))) {
        topLevel.add(entry);
      }
    }
  }
  staged.bundleDependencies = [...(staged.bundleDependencies ?? []), ...topLevel].sort();
  fs.writeFileSync(path.join(stagingRoot, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  return stagingRoot;
}

// Fail-closed guard: an own tarball must not carry the renamed official packages — if it
// did, the daemon could resolve the official server instead of the own one.
export function assertNoOfficialRenamedPackages(stagingRoot) {
  const found = new Set();
  const check = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name.startsWith("@")) {
        check(full);
        continue;
      }
      const pkgPath = path.join(full, "package.json");
      if (fs.existsSync(pkgPath)) {
        const name = readJson(pkgPath).name;
        if (OWN_RENAMED_OFFICIAL_NAMES.includes(name)) found.add(name);
      }
      check(full);
    }
  };
  check(path.join(stagingRoot, "node_modules"));
  if (found.size > 0) {
    throw new Error(
      `staging carries official ${[...found].join(", ")} — run set-distribution.mjs --own --rewrite-packages before packing`,
    );
  }
}

export function packOwnRelease({
  repoRoot = REPO_ROOT,
  outDir = path.join(repoRoot, "dist", "own"),
  packages = [path.join(repoRoot, "packages", "cli"), path.join(repoRoot, "packages", "server")],
  runPack = (cwd) =>
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir], {
      cwd,
      encoding: "utf8",
    }),
}) {
  fs.mkdirSync(outDir, { recursive: true });
  const tarballs = [];
  for (const packageDir of packages) {
    const before = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
    const stagingRoot = stageProductionClosure(repoRoot, packageDir);
    try {
      assertNoOfficialRenamedPackages(stagingRoot);
      runPack(stagingRoot);
    } finally {
      fs.rmSync(path.dirname(stagingRoot), { recursive: true, force: true });
    }
    const produced = fs.readdirSync(outDir).filter((f) => f.endsWith(".tgz") && !before.has(f));
    if (produced.length !== 1) {
      throw new Error(
        `expected exactly one tarball from packing ${packageDir}, got: ${produced.join(", ") || "none"}`,
      );
    }
    tarballs.push(path.join(outDir, produced[0]));
  }
  return tarballs;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") options.outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--root") options.repoRoot = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

if (isMainModule(import.meta.url)) {
  const tarballs = packOwnRelease(parseArgs(process.argv.slice(2)));
  for (const tarball of tarballs) process.stdout.write(`${tarball}\n`);
}
