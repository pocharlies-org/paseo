// Packaging-time tool: fix a build's distribution channel by rewriting the baked values
// in the source before it is built. It is run by whoever produces the binaries (CI), never
// by an end user, and it changes *committed source* deterministically so the resulting
// artifact carries the chosen channel and the runtime never consults an environment
// variable to decide where to download from.
//
// What it rewrites:
//   1. packages/protocol/src/distribution.ts  — the DISTRIBUTION literal (between markers).
//   2. packages/desktop/electron-builder.yml   — the `publish:` owner/repo (the GitHub
//      releases feed electron-builder bakes into the packaged app-update.yml, which
//      electron-updater reads at runtime). Only the publish block is touched, so signing
//      and notarization settings are left exactly as committed.
//
// Modes (mutually exclusive, order-independent; default is `--official`):
//   --official  the upstream channel, which is what is committed.
//   --own       the pocharlies-org/paseo GitHub releases channel AND an explicit own npm
//               package. FAIL-CLOSED: --own refuses to run unless --npm-cli-package and
//               --npm-server-package are both supplied and differ from the official
//               @getpaseo/* packages. There is no silent fallback to the official npm
//               package: an "own" build whose CLI self-update still installs
//               @getpaseo/cli@latest is not a coherent own channel, so we fail before
//               writing anything rather than ship a half-own build.
//
// Own npm channel (SC-5508, resolves the earlier blocker): --own with --rewrite-packages
// renames the four packages the own CLI tarball needs (cli/server/client/protocol) to the
// own scope derived from --npm-cli-package, rewrites their cross-package import
// specifiers (the CLI publishes tsc output unbundled, so "@getpaseo/server/..." would be
// ERR_MODULE_NOT_FOUND in an own install), rewrites the dependency keys and workspace
// script selectors that name those packages, and marks the own server/client/protocol as
// bundleDependencies of the CLI. scripts/pack-own-release.mjs then assembles the full
// production closure into the CLI's node_modules so `npm install -g <own-cli.tgz>` never
// resolves against the public registry. Packages outside the four (highlight, plugin,
// relay) keep their names: they ride inside the bundled closure unchanged. The official
// defaults stay committed; --official restores the marker-rewritten files exactly, and a
// packaging checkout is disposable (git restores the names).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DISTRIBUTION_FILE = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "distribution.ts",
);
export const ELECTRON_BUILDER_FILE = path.join(
  REPO_ROOT,
  "packages",
  "desktop",
  "electron-builder.yml",
);

const BEGIN_MARKER = "// DISTRIBUTION:BEGIN";
const END_MARKER = "// DISTRIBUTION:END";

export const OFFICIAL_DISTRIBUTION = {
  githubOwner: "getpaseo",
  githubRepo: "paseo",
  npmCliPackage: "@getpaseo/cli",
  npmServerPackage: "@getpaseo/server",
  npmCliDistTag: "latest",
};

// Own GitHub releases channel. The owner is the real repo owner (pocharlies-org), not the
// old pocharlies path: pocharlies/paseo is only a transfer redirect and must not be baked
// into the feed. The npm package fields are intentionally left unset: an own channel must
// name its own packages explicitly (fail-closed), never inherit the official ones. See the
// blocker note above.
export const OWN_DISTRIBUTION = {
  githubOwner: "pocharlies-org",
  githubRepo: "paseo",
  npmCliPackage: undefined,
  npmServerPackage: undefined,
  npmCliDistTag: "latest",
};

const KEYS = ["githubOwner", "githubRepo", "npmCliPackage", "npmServerPackage", "npmCliDistTag"];

const FLAG_TO_KEY = {
  "--github-owner": "githubOwner",
  "--github-repo": "githubRepo",
  "--npm-cli-package": "npmCliPackage",
  "--npm-server-package": "npmServerPackage",
  "--npm-cli-dist-tag": "npmCliDistTag",
};

export function resolveConfig(argv) {
  let mode = "official";
  let sawOfficial = false;
  let sawOwn = false;
  let rewritePackages = false;
  const overrides = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rewrite-packages") {
      rewritePackages = true;
      continue;
    }
    if (arg === "--official") {
      if (sawOwn) throw new Error("--official and --own are mutually exclusive");
      sawOfficial = true;
      mode = "official";
      continue;
    }
    if (arg === "--own") {
      if (sawOfficial) throw new Error("--official and --own are mutually exclusive");
      sawOwn = true;
      mode = "own";
      continue;
    }
    const key = FLAG_TO_KEY[arg];
    if (key) {
      overrides[key] = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  // Baseline from the mode, then explicit overrides applied last so flag order never
  // changes the result (no misleading "--own after --npm-* resets it" behaviour).
  const baseline = mode === "own" ? OWN_DISTRIBUTION : OFFICIAL_DISTRIBUTION;
  const config = { ...baseline, ...overrides };

  if (mode === "own") {
    assertOwnNpmChannel(config);
  } else if (rewritePackages) {
    throw new Error("--rewrite-packages requires --own (fail-closed: never rename to official)");
  }

  validateConfig(config);
  return { mode, config, rewritePackages };
}

// Fail-closed: an own channel must point at its own npm packages. Missing or official
// values are rejected before any file is written.
function assertOwnNpmChannel(config) {
  const missing = ["npmCliPackage", "npmServerPackage"].filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `--own requires an explicit own npm package: pass ${missing
        .map((key) => `--${key === "npmCliPackage" ? "npm-cli-package" : "npm-server-package"}`)
        .join(" and ")} different from the official @getpaseo/* packages. ` +
        "Refusing to fall back to the official package (see the blocker note).",
    );
  }
  const sameAsOfficial = ["npmCliPackage", "npmServerPackage"].filter(
    (key) => config[key] === OFFICIAL_DISTRIBUTION[key],
  );
  if (sameAsOfficial.length > 0) {
    throw new Error(
      `--own npm package must differ from the official ${sameAsOfficial
        .map((key) => OFFICIAL_DISTRIBUTION[key])
        .join(" / ")}; got the official value.`,
    );
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function validateConfig(config) {
  for (const key of KEYS) {
    const value = config[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Distribution ${key} must be a non-empty string`);
    }
  }
}

// Render the canonical DISTRIBUTION object literal (no trailing newline) for the markers.
export function renderDistributionBlock(config) {
  const lines = ["export const DISTRIBUTION: DistributionConfig = {"];
  for (const key of KEYS) {
    lines.push(`  ${key}: ${JSON.stringify(config[key])},`);
  }
  lines.push("};");
  return lines.join("\n");
}

// Replace the lines strictly between the BEGIN/END markers with the rendered block.
export function rewriteDistributionSource(source, config) {
  const lines = source.split("\n");
  const begin = lines.findIndex((line) => line.startsWith(BEGIN_MARKER));
  const end = lines.findIndex((line) => line.startsWith(END_MARKER));
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("distribution.ts is missing the DISTRIBUTION BEGIN/END markers");
  }
  const block = renderDistributionBlock(config).split("\n");
  return [...lines.slice(0, begin + 1), ...block, ...lines.slice(end)].join("\n");
}

// Rewrite the `owner:`/`repo:` values inside the top-level `publish:` block only. Other
// keys (and the whole mac/signing section) are returned untouched.
export function rewriteElectronBuilderPublish(source, config) {
  const lines = source.split("\n");
  const out = [...lines];
  let inPublish = false;
  let sawPublish = false;

  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    const isTopLevel = line.length > 0 && !/^\s/.test(line);
    if (isTopLevel) {
      inPublish = line.startsWith("publish:");
      if (inPublish) sawPublish = true;
      continue;
    }
    if (!inPublish) continue;
    const owner = line.match(/^(\s+)owner:\s*\S+\s*$/);
    const repo = line.match(/^(\s+)repo:\s*\S+\s*$/);
    if (owner) out[i] = `${owner[1]}owner: ${config.githubOwner}`;
    else if (repo) out[i] = `${repo[1]}repo: ${config.githubRepo}`;
  }

  if (!sawPublish) {
    throw new Error("electron-builder.yml has no top-level publish: block");
  }
  return out.join("\n");
}

// The four packages the own CLI tarball renames to the own scope. Everything else
// (highlight, plugin, relay, app, desktop) keeps its committed name: it either rides
// inside the bundled closure or is not part of the npm install path.
export const OWN_RENAMED_OFFICIAL_NAMES = [
  "@getpaseo/cli",
  "@getpaseo/server",
  "@getpaseo/client",
  "@getpaseo/protocol",
];

// Derive the own names from the fail-closed explicit CLI/server packages. Both must be
// scoped and share one scope, so client/protocol derive from it deterministically.
export function ownPackageNames(config) {
  const scopeOf = (pkg, flag) => {
    const match = /^(@[^/]+)\/[^/]+$/.exec(pkg ?? "");
    if (!match) {
      throw new Error(`--own ${flag} must be a scoped package (got "${pkg}")`);
    }
    return match[1];
  };
  const cliScope = scopeOf(config.npmCliPackage, "npm-cli-package");
  const serverScope = scopeOf(config.npmServerPackage, "npm-server-package");
  if (cliScope !== serverScope) {
    throw new Error(
      `--own npm-cli-package and --npm-server-package must share one scope (got ${cliScope} and ${serverScope})`,
    );
  }
  return {
    "@getpaseo/cli": config.npmCliPackage,
    "@getpaseo/server": config.npmServerPackage,
    "@getpaseo/client": `${cliScope}/client`,
    "@getpaseo/protocol": `${cliScope}/protocol`,
  };
}

// package.json text: rename targets wherever the token appears — the "name" field,
// dependency keys, and workspace script selectors like --workspace=@getpaseo/server.
export function rewritePackageJsonNames(source, names) {
  let out = source;
  for (const [official, own] of Object.entries(names)) {
    const escaped = official.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Subpath references ("@getpaseo/server/daemon-control" in script strings).
    out = out.replaceAll(`${official}/`, `${own}/`);
    // Whole-token references: "name" fields, dependency keys, and bare script selectors
    // ("--workspace=@getpaseo/server").
    out = out.replace(new RegExp(`${escaped}(?![\\w./-])`, "g"), own);
  }
  return out;
}

// Source text: rewrite only module specifiers in import/export-from/require contexts,
// never data strings (the committed OFFICIAL_DISTRIBUTION literals must stay official).
export function rewriteImportSpecifiers(source, names) {
  const alternation = Object.keys(names)
    .map((official) => official.replace("/", "\\/"))
    .join("|");
  const pattern = new RegExp(
    `(\\b(?:require\\.resolve|require|import|from)\\s*\\(?\\s*)(["'])(${alternation})((?:\\/[^"']*)?)\\2`,
    "g",
  );
  return source.replace(pattern, (match, prefix, quote, official, subpath) => {
    return `${prefix}${quote}${names[official]}${subpath}${quote}`;
  });
}

// The CLI tarball is self-contained: npm packs (and the installer extracts without any
// registry resolution) every package listed in bundleDependencies that sits in its
// node_modules. Mark the own server/client/protocol here; pack-own-release.mjs extends the
// list to the full production closure.
export function markCliBundleDependencies(cliPackageJsonSource, names) {
  const pkg = JSON.parse(cliPackageJsonSource);
  pkg.bundleDependencies = [
    names["@getpaseo/server"],
    names["@getpaseo/client"],
    names["@getpaseo/protocol"],
  ];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "build", ".next"]);

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

// Rewrite every package.json (name/dep keys/script tokens) and every source file
// (import specifiers) under repoRoot. Deterministic and idempotent.
export function applyOwnPackageRewrites(repoRoot, config) {
  const names = ownPackageNames(config);
  // The root package.json holds the workspace script selectors
  // ("npm run build --workspace=@getpaseo/server"), so it is rewritten too.
  const targets = [path.join(repoRoot, "package.json")];
  const roots = [
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "scripts"),
    path.join(repoRoot, "plugins"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkFiles(root)) {
      const base = path.basename(file);
      const ext = path.extname(file);
      const isPackageJson = base === "package.json";
      if (!isPackageJson && !SOURCE_EXTENSIONS.has(ext)) continue;
      targets.push(file);
    }
  }
  const changed = [];
  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    const isPackageJson = path.basename(file) === "package.json";
    const before = fs.readFileSync(file, "utf8");
    const after = isPackageJson
      ? rewritePackageJsonNames(before, names)
      : rewriteImportSpecifiers(before, names);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(file);
    }
  }
  const cliJsonPath = path.join(repoRoot, "packages", "cli", "package.json");
  const cliBefore = fs.readFileSync(cliJsonPath, "utf8");
  const cliAfter = markCliBundleDependencies(cliBefore, names);
  if (cliAfter !== cliBefore) {
    fs.writeFileSync(cliJsonPath, cliAfter);
    if (!changed.includes(cliJsonPath)) changed.push(cliJsonPath);
  }
  return changed;
}

export function applyDistribution(
  config,
  {
    distributionPath = DISTRIBUTION_FILE,
    builderPath = ELECTRON_BUILDER_FILE,
    repoRoot = null,
    rewritePackages = false,
  } = {},
) {
  fs.writeFileSync(
    distributionPath,
    rewriteDistributionSource(fs.readFileSync(distributionPath, "utf8"), config),
  );
  fs.writeFileSync(
    builderPath,
    rewriteElectronBuilderPublish(fs.readFileSync(builderPath, "utf8"), config),
  );
  if (rewritePackages) {
    if (config.npmCliPackage === OFFICIAL_DISTRIBUTION.npmCliPackage) {
      throw new Error("--rewrite-packages is only valid with an own npm package (fail-closed)");
    }
    return applyOwnPackageRewrites(repoRoot ?? REPO_ROOT, config);
  }
  return [];
}

// Full CLI flow: resolve (and validate, fail-closed) BEFORE touching any file.
export function run(argv, paths) {
  const { mode, config, rewritePackages } = resolveConfig(argv);
  const changed = applyDistribution(config, { ...paths, rewritePackages });
  return { mode, config, changed };
}

function usageAndExit(code) {
  process.stderr.write(
    "Usage: node scripts/set-distribution.mjs [--official | --own] " +
      "(--own also requires --npm-cli-package and --npm-server-package) " +
      "[--rewrite-packages] " +
      "[--github-owner <o>] [--github-repo <r>] [--npm-cli-dist-tag <tag>]\n",
  );
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  const { mode, config, changed } = run(process.argv.slice(2));
  const packagesNote = changed.length > 0 ? `, ${changed.length} package files rewritten` : "";
  process.stdout.write(
    `Distribution set to ${mode}: github ${config.githubOwner}/${config.githubRepo}, ` +
      `npm ${config.npmCliPackage}@${config.npmCliDistTag}${packagesNote}\n`,
  );
}
