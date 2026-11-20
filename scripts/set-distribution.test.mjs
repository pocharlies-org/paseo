import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  OFFICIAL_DISTRIBUTION,
  OWN_DISTRIBUTION,
  applyDistribution,
  applyOwnPackageRewrites,
  markCliBundleDependencies,
  ownPackageNames,
  renderDistributionBlock,
  resolveConfig,
  rewriteDistributionSource,
  rewriteElectronBuilderPublish,
  rewriteImportSpecifiers,
  rewritePackageJsonNames,
  run,
} from "./set-distribution.mjs";

const DISTRIBUTION_SAMPLE = [
  "export interface DistributionConfig {",
  "  githubOwner: string;",
  "}",
  "",
  "// DISTRIBUTION:BEGIN (rewritten by scripts/set-distribution.mjs at packaging time)",
  "export const DISTRIBUTION: DistributionConfig = {",
  '  githubOwner: "getpaseo",',
  '  githubRepo: "paseo",',
  '  npmCliPackage: "@getpaseo/cli",',
  '  npmServerPackage: "@getpaseo/server",',
  '  npmCliDistTag: "latest",',
  "};",
  "// DISTRIBUTION:END",
  "",
  "export function githubReleaseDownloadBaseUrl() {",
  "  return 1;",
  "}",
].join("\n");

const BUILDER_SAMPLE = [
  "appId: sh.paseo.desktop",
  "productName: Paseo",
  "publish:",
  "  provider: github",
  "  owner: getpaseo",
  "  repo: paseo",
  "mac:",
  "  notarize: true",
  "  hardenedRuntime: true",
  "  category: public.app-category.developer-tools",
].join("\n");

const COMPLETE_OWN = [
  "--own",
  "--npm-cli-package",
  "@pocharlies/cli",
  "--npm-server-package",
  "@pocharlies/server",
];

test("resolveConfig defaults to official", () => {
  assert.equal(resolveConfig([]).mode, "official");
  assert.deepEqual(resolveConfig([]).config, OFFICIAL_DISTRIBUTION);
  assert.equal(resolveConfig(["--official"]).config.githubOwner, "getpaseo");
});

test("own channel targets the real org owner, not the redirect path", () => {
  assert.equal(OWN_DISTRIBUTION.githubOwner, "pocharlies-org");
  const { config } = resolveConfig(COMPLETE_OWN);
  assert.equal(config.githubOwner, "pocharlies-org");
  assert.equal(config.githubRepo, "paseo");
});

test("--own is fail-closed: rejects incomplete and official npm packages", () => {
  // Missing npm packages entirely.
  assert.throws(() => resolveConfig(["--own"]), /requires an explicit own npm package/);
  // Only the CLI package, missing the server package.
  assert.throws(
    () => resolveConfig(["--own", "--npm-cli-package", "@pocharlies/cli"]),
    /npm-server-package/,
  );
  // An npm package that equals the official value is rejected (no silent official fallback).
  assert.throws(
    () =>
      resolveConfig([
        "--own",
        "--npm-cli-package",
        "@getpaseo/cli",
        "--npm-server-package",
        "@pocharlies/server",
      ]),
    /must differ from the official/,
  );
});

test("--own preserves the explicit own npm packages", () => {
  const { config } = resolveConfig(COMPLETE_OWN);
  assert.deepEqual(config, {
    githubOwner: "pocharlies-org",
    githubRepo: "paseo",
    npmCliPackage: "@pocharlies/cli",
    npmServerPackage: "@pocharlies/server",
    npmCliDistTag: "latest",
  });
});

test("mode selection is order-independent (no misleading flag order)", () => {
  const after = resolveConfig(COMPLETE_OWN).config;
  const before = resolveConfig([
    "--npm-cli-package",
    "@pocharlies/cli",
    "--npm-server-package",
    "@pocharlies/server",
    "--own",
  ]).config;
  assert.deepEqual(before, after);
});

test("--official and --own are mutually exclusive", () => {
  assert.throws(() => resolveConfig(["--own", "--official"]), /mutually exclusive/);
  assert.throws(() => resolveConfig(["--official", "--own"]), /mutually exclusive/);
});

test("renderDistributionBlock emits the configured literal", () => {
  const block = renderDistributionBlock({
    ...OWN_DISTRIBUTION,
    npmCliPackage: "@pocharlies/cli",
    npmServerPackage: "@pocharlies/server",
  });
  assert.match(block, /githubOwner: "pocharlies-org"/);
  assert.match(block, /npmCliPackage: "@pocharlies\/cli"/);
});

test("rewriteDistributionSource replaces only the marked block and is idempotent", () => {
  const own = {
    ...OWN_DISTRIBUTION,
    npmCliPackage: "@pocharlies/cli",
    npmServerPackage: "@pocharlies/server",
  };
  const once = rewriteDistributionSource(DISTRIBUTION_SAMPLE, own);
  assert.equal(rewriteDistributionSource(once, own), once);
  assert.match(once, /githubOwner: "pocharlies-org"/);
  assert.match(once, /export function githubReleaseDownloadBaseUrl/);
  assert.match(once, /DISTRIBUTION:BEGIN/);
  assert.match(once, /DISTRIBUTION:END/);
});

test("rewriteDistributionSource throws when markers are missing", () => {
  assert.throws(
    () => rewriteDistributionSource("no markers here", OFFICIAL_DISTRIBUTION),
    /markers/,
  );
});

test("rewriteElectronBuilderPublish changes only the publish block, leaving signing intact", () => {
  const next = rewriteElectronBuilderPublish(BUILDER_SAMPLE, { ...OWN_DISTRIBUTION });
  assert.match(next, /  owner: pocharlies-org/);
  assert.match(next, /  repo: paseo/);
  assert.match(next, /notarize: true/);
  assert.match(next, /hardenedRuntime: true/);
  assert.equal(rewriteElectronBuilderPublish(next, OWN_DISTRIBUTION), next);
});

test("rewriteElectronBuilderPublish throws when publish block is absent", () => {
  assert.throws(
    () => rewriteElectronBuilderPublish("productName: Paseo\n", OWN_DISTRIBUTION),
    /publish/,
  );
});

test("run rejects incomplete --own and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-set-dist-"));
  try {
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);
    writeFileSync(path.join(dir, "cli.ts"), 'import { x } from "@getpaseo/server";\n');

    assert.throws(
      () => run(["--own"], { distributionPath: distPath, builderPath, repoRoot: dir }),
      /explicit own npm package/,
    );
    // No writes happened: the channel files are byte-identical and no source was renamed.
    assert.equal(readFileSync(distPath, "utf8"), DISTRIBUTION_SAMPLE);
    assert.equal(readFileSync(builderPath, "utf8"), BUILDER_SAMPLE);
    assert.equal(
      readFileSync(path.join(dir, "cli.ts"), "utf8"),
      'import { x } from "@getpaseo/server";\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run writes a coherent own channel and --official restores the committed default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-set-dist-"));
  try {
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);

    run(COMPLETE_OWN, { distributionPath: distPath, builderPath });
    const dist = readFileSync(distPath, "utf8");
    assert.match(dist, /githubOwner: "pocharlies-org"/);
    assert.match(dist, /npmCliPackage: "@pocharlies\/cli"/);
    assert.match(dist, /npmServerPackage: "@pocharlies\/server"/);
    assert.match(readFileSync(builderPath, "utf8"), /owner: pocharlies-org/);

    run(["--official"], { distributionPath: distPath, builderPath });
    assert.equal(readFileSync(distPath, "utf8"), DISTRIBUTION_SAMPLE);
    assert.equal(readFileSync(builderPath, "utf8"), BUILDER_SAMPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDistribution round-trips official exactly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-set-dist-"));
  try {
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);
    applyDistribution(OFFICIAL_DISTRIBUTION, { distributionPath: distPath, builderPath });
    assert.equal(readFileSync(distPath, "utf8"), DISTRIBUTION_SAMPLE);
    assert.equal(readFileSync(builderPath, "utf8"), BUILDER_SAMPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const OWN_NAMES = {
  "@getpaseo/cli": "@pocharlies/cli",
  "@getpaseo/server": "@pocharlies/server",
  "@getpaseo/client": "@pocharlies/client",
  "@getpaseo/protocol": "@pocharlies/protocol",
};

test("ownPackageNames derives client/protocol from the CLI scope", () => {
  assert.deepEqual(ownPackageNames(resolveConfig(COMPLETE_OWN).config), OWN_NAMES);
});

test("ownPackageNames rejects unscoped or split-scope own packages", () => {
  assert.throws(
    () => ownPackageNames({ npmCliPackage: "paseo-cli", npmServerPackage: "@pocharlies/server" }),
    /scoped/,
  );
  assert.throws(
    () =>
      ownPackageNames({
        npmCliPackage: "@pocharlies/cli",
        npmServerPackage: "@other/server",
      }),
    /share one scope/,
  );
});

test("rewritePackageJsonNames renames name, dep keys and workspace script selectors", () => {
  const source = JSON.stringify(
    {
      name: "@getpaseo/cli",
      scripts: { build: "npm run build --workspace=@getpaseo/server" },
      dependencies: {
        "@getpaseo/client": "0.1.0",
        "@getpaseo/protocol": "0.1.0",
        "@getpaseo/highlight": "0.1.0",
        commander: "^12.0.0",
      },
    },
    null,
    2,
  );
  const next = rewritePackageJsonNames(source, OWN_NAMES);
  assert.match(next, /"@pocharlies\/cli"/);
  assert.match(next, /--workspace=@pocharlies\/server/);
  assert.match(next, /"@pocharlies\/client": "0\.1\.0"/);
  assert.match(next, /"@pocharlies\/protocol": "0\.1\.0"/);
  // Packages outside the four keep their official name (they ride in the closure).
  assert.match(next, /"@getpaseo\/highlight": "0\.1\.0"/);
  assert.equal(rewritePackageJsonNames(next, OWN_NAMES), next);
});

test("rewriteImportSpecifiers rewrites module specifiers but never data strings", () => {
  const source = [
    'import { x } from "@getpaseo/protocol/distribution";',
    'import { y } from "@getpaseo/server";',
    'const { z } = require("@getpaseo/client");',
    'const p = require.resolve("@getpaseo/server/daemon-control");',
    'await import("@getpaseo/protocol/messages");',
    'const data = { npmServerPackage: "@getpaseo/server" };',
  ].join("\n");
  const next = rewriteImportSpecifiers(source, OWN_NAMES);
  assert.match(next, /from "@pocharlies\/protocol\/distribution"/);
  assert.match(next, /from "@pocharlies\/server"/);
  assert.match(next, /require\("@pocharlies\/client"\)/);
  assert.match(next, /require\.resolve\("@pocharlies\/server\/daemon-control"\)/);
  assert.match(next, /import\("@pocharlies\/protocol\/messages"\)/);
  // The committed OFFICIAL_DISTRIBUTION-style data literal stays official.
  assert.match(next, /npmServerPackage: "@getpaseo\/server"/);
  assert.equal(rewriteImportSpecifiers(next, OWN_NAMES), next);
});

test("markCliBundleDependencies lists the own server/client/protocol", () => {
  const source = JSON.stringify({ name: "@pocharlies/cli", dependencies: {} }, null, 2);
  const marked = JSON.parse(markCliBundleDependencies(source, OWN_NAMES));
  assert.deepEqual(marked.bundleDependencies, [
    "@pocharlies/server",
    "@pocharlies/client",
    "@pocharlies/protocol",
  ]);
});

function createRewriteFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-own-rewrite-"));
  const write = (rel, content) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  write(
    "package.json",
    JSON.stringify(
      {
        name: "paseo",
        scripts: { "build:server": "npm run build --workspace=@getpaseo/server" },
      },
      null,
      2,
    ),
  );
  const cliJson = write(
    "packages/cli/package.json",
    JSON.stringify(
      {
        name: "@getpaseo/cli",
        dependencies: {
          "@getpaseo/client": "0.1.0",
          "@getpaseo/protocol": "0.1.0",
          "@getpaseo/server": "0.1.0",
          commander: "^12.0.0",
        },
      },
      null,
      2,
    ),
  );
  write(
    "packages/server/package.json",
    JSON.stringify(
      {
        name: "@getpaseo/server",
        dependencies: { "@getpaseo/client": "0.1.0", "@getpaseo/relay": "0.1.0" },
      },
      null,
      2,
    ),
  );
  write(
    "packages/client/package.json",
    JSON.stringify({ name: "@getpaseo/client", dependencies: {} }, null, 2),
  );
  write(
    "packages/protocol/package.json",
    JSON.stringify({ name: "@getpaseo/protocol", dependencies: {} }, null, 2),
  );
  write(
    "packages/cli/src/daemon/local-daemon.ts",
    [
      'import { start } from "@getpaseo/server/daemon-control";',
      'import { DISTRIBUTION } from "@getpaseo/protocol/distribution";',
      'const name = "@getpaseo/server";',
    ].join("\n"),
  );
  write(
    "packages/server/src/daemon-version.ts",
    'import { DISTRIBUTION } from "@getpaseo/protocol/distribution";\n',
  );
  write("packages/server/node_modules/keep/package.json", '{"name":"skip-me"}');
  return { dir, cliJson };
}

test("applyOwnPackageRewrites renames the tree and is idempotent", () => {
  const { dir } = createRewriteFixture();
  try {
    const config = resolveConfig(COMPLETE_OWN).config;
    const changed = applyOwnPackageRewrites(dir, config);
    assert.ok(changed.length > 0);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts["build:server"],
      "npm run build --workspace=@pocharlies/server",
    );
    const cliJson = JSON.parse(readFileSync(path.join(dir, "packages/cli/package.json"), "utf8"));
    assert.equal(cliJson.name, "@pocharlies/cli");
    assert.deepEqual(cliJson.dependencies["@pocharlies/server"], "0.1.0");
    assert.ok(!("@getpaseo/server" in cliJson.dependencies));
    // relay (outside the four) keeps its official dependency key.
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "packages/server/package.json"), "utf8")).dependencies[
        "@getpaseo/relay"
      ],
      "0.1.0",
    );
    const daemon = readFileSync(path.join(dir, "packages/cli/src/daemon/local-daemon.ts"), "utf8");
    assert.match(daemon, /from "@pocharlies\/server\/daemon-control"/);
    assert.match(daemon, /from "@pocharlies\/protocol\/distribution"/);
    // The data literal on line 3 is not an import specifier: untouched.
    assert.match(daemon, /const name = "@getpaseo\/server"/);
    // node_modules is never rewritten.
    assert.equal(
      readFileSync(path.join(dir, "packages/server/node_modules/keep/package.json"), "utf8"),
      '{"name":"skip-me"}',
    );
    // Idempotent: a second run changes nothing.
    assert.deepEqual(applyOwnPackageRewrites(dir, config), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run --own --rewrite-packages rewrites the tree; --rewrite-packages needs --own", () => {
  const { dir } = createRewriteFixture();
  try {
    assert.throws(() => resolveConfig(["--rewrite-packages"]), /requires --own/);
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);
    const result = run([...COMPLETE_OWN, "--rewrite-packages"], {
      distributionPath: distPath,
      builderPath,
      repoRoot: dir,
    });
    assert.equal(result.mode, "own");
    assert.ok(result.changed.length > 0);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "packages/cli/package.json"), "utf8")).name,
      "@pocharlies/cli",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
