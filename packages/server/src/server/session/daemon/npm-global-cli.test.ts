import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DefaultNpmGlobalPaseoCli,
  isOwnReleaseChannel,
  parseOwnRelease,
  resolveLatestOwnRelease,
  type OwnReleaseInfo,
} from "./npm-global-cli.js";
import { OFFICIAL_DISTRIBUTION, type DistributionConfig } from "@getpaseo/protocol/distribution";

interface CommandCall {
  command: string;
  args: string[];
  timeout?: number;
  maxBuffer?: number;
}

const globalRoot = path.join(path.sep, "global", "lib");

interface GlobalInstall {
  root: string;
  packagePath: string;
  // npm 7+ `ls --json --long` marks neither kind of install with a link flag.
  npmLsJson: string;
}

describe("DefaultNpmGlobalPaseoCli", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createGlobalInstall(options: { linked: boolean }): GlobalInstall {
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-npm-global-"));
    tempDirs.push(dir);
    const root = path.join(dir, "prefix", "lib");
    const packagePath = path.join(root, "node_modules", "@getpaseo", "cli");
    const checkoutCli = path.join(dir, "checkout", "packages", "cli");
    if (options.linked) {
      mkdirSync(checkoutCli, { recursive: true });
      mkdirSync(path.dirname(packagePath), { recursive: true });
      symlinkSync(checkoutCli, packagePath, "junction");
    } else {
      mkdirSync(packagePath, { recursive: true });
    }
    const npmLsJson = JSON.stringify({
      name: "lib",
      path: root,
      dependencies: {
        "@getpaseo/cli": {
          version: "0.1.15",
          resolved: options.linked
            ? `file:${path.relative(root, checkoutCli)}`
            : "https://registry.npmjs.org/@getpaseo/cli/-/cli-0.1.15.tgz",
          path: packagePath,
        },
      },
    });
    return { root, packagePath, npmLsJson };
  }

  test("reports a global install linked to a local checkout as linked", async () => {
    const install = createGlobalInstall({ linked: true });
    const cli = new DefaultNpmGlobalPaseoCli(async () => ({
      exitCode: 0,
      stdout: install.npmLsJson,
      stderr: "",
    }));

    await expect(cli.inspect()).resolves.toMatchObject({ isLinked: true });
  });

  test("inspects the npm global cli install with npm -g ls", async () => {
    const install = createGlobalInstall({ linked: false });
    const calls: CommandCall[] = [];
    const cli = new DefaultNpmGlobalPaseoCli(async (command, args, options) => {
      calls.push({
        command,
        args,
        timeout: options?.timeout,
        maxBuffer: options?.maxBuffer,
      });
      return { exitCode: 0, stdout: install.npmLsJson, stderr: "" };
    });

    await expect(cli.inspect()).resolves.toEqual({
      version: "0.1.15",
      packagePath: install.packagePath,
      globalRootPath: install.root,
      isLinked: false,
    });
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["-g", "ls", "@getpaseo/cli", "--json", "--depth=0", "--long"],
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
  });

  test("runs the global install command for the latest cli", async () => {
    const calls: CommandCall[] = [];
    const cli = new DefaultNpmGlobalPaseoCli(async (command, args, options) => {
      calls.push({
        command,
        args,
        timeout: options?.timeout,
        maxBuffer: options?.maxBuffer,
      });
      return { exitCode: 0, stdout: "changed 42 packages", stderr: "" };
    });

    await expect(cli.installLatest()).resolves.toEqual({
      exitCode: 0,
      stdout: "changed 42 packages",
      stderr: "",
    });
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["install", "-g", "@getpaseo/cli@latest"],
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
  });

  test("reports missing npm when npm exits without JSON", async () => {
    const cli = new DefaultNpmGlobalPaseoCli(async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "npm: command not found",
    }));

    await expect(cli.inspect()).rejects.toThrow("npm: command not found");
  });

  test("reports missing global cli when npm output has no cli dependency", async () => {
    const cli = new DefaultNpmGlobalPaseoCli(async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ name: "lib", path: globalRoot, dependencies: {} }),
      stderr: "missing",
    }));

    await expect(cli.inspect()).rejects.toThrow(
      "@getpaseo/cli is not installed with npm -g on this host",
    );
  });
});

const OWN_CHANNEL: DistributionConfig = {
  githubOwner: "pocharlies-org",
  githubRepo: "paseo",
  npmCliPackage: "@pocharlies/cli",
  npmServerPackage: "@pocharlies/server",
  npmCliDistTag: "latest",
};

const FIXTURE_RELEASE = {
  tag_name: "own-v0.12.1",
  body: "Distribución propia.\n\nupstream: 0.12.0\n",
  assets: [
    {
      name: "pocharlies-cli-0.12.1.tgz",
      browser_download_url:
        "https://github.com/pocharlies-org/paseo/releases/download/own-v0.12.1/pocharlies-cli-0.12.1.tgz",
    },
    {
      name: "Paseo-0.12.1.dmg",
      browser_download_url:
        "https://github.com/pocharlies-org/paseo/releases/download/own-v0.12.1/Paseo-0.12.1.dmg",
    },
  ],
};

describe("own release channel discovery", () => {
  test("the official channel is not own; an own package selection is", () => {
    expect(isOwnReleaseChannel(OFFICIAL_DISTRIBUTION)).toBe(false);
    expect(isOwnReleaseChannel(OWN_CHANNEL)).toBe(true);
  });

  test("parseOwnRelease reads version, upstream metadata and the own CLI tarball", () => {
    const release = parseOwnRelease(FIXTURE_RELEASE, OWN_CHANNEL);
    expect(release).toEqual({
      version: "0.12.1",
      upstreamVersion: "0.12.0",
      tarballUrl: FIXTURE_RELEASE.assets[0].browser_download_url,
    });
  });

  test("parseOwnRelease falls back to the tag for the upstream version", () => {
    const release = parseOwnRelease(
      { ...FIXTURE_RELEASE, body: null, tag_name: "v0.12.3-own.1" },
      OWN_CHANNEL,
    );
    expect(release.version).toBe("0.12.3-own.1");
    expect(release.upstreamVersion).toBe("0.12.3");
  });

  test("parseOwnRelease fails when the own tarball asset is missing", () => {
    expect(() => parseOwnRelease({ ...FIXTURE_RELEASE, assets: [] }, OWN_CHANNEL)).toThrow(
      /no own CLI tarball asset/,
    );
  });

  test("resolveLatestOwnRelease queries the own GitHub releases API, never the registry", async () => {
    const urls: string[] = [];
    const release = await resolveLatestOwnRelease(OWN_CHANNEL, async (url) => {
      urls.push(url);
      return FIXTURE_RELEASE;
    });
    expect(urls).toEqual(["https://api.github.com/repos/pocharlies-org/paseo/releases/latest"]);
    expect(release.version).toBe("0.12.1");
  });

  test("installLatest on an own channel installs the release tarball, never an npm spec", async () => {
    const calls: CommandCall[] = [];
    const downloaded: { url?: string; dest?: string } = {};
    const cli = new DefaultNpmGlobalPaseoCli(
      async (command, args, options) => {
        calls.push({ command, args, timeout: options?.timeout, maxBuffer: options?.maxBuffer });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      {
        distribution: OWN_CHANNEL,
        resolveLatestRelease: async (): Promise<OwnReleaseInfo> =>
          parseOwnRelease(FIXTURE_RELEASE, OWN_CHANNEL),
        downloadFile: async (url, dest) => {
          downloaded.url = url;
          downloaded.dest = dest;
        },
        tempDir: () => "/tmp/paseo-own-test",
      },
    );

    await cli.installLatest({ prefix: "/prefix" });
    expect(downloaded.url).toBe(FIXTURE_RELEASE.assets[0].browser_download_url);
    expect(calls).toEqual([
      {
        command: "npm",
        args: [
          "install",
          "-g",
          path.join("/tmp/paseo-own-test", "paseo-own-cli-0.12.1.tgz"),
          "--prefix",
          "/prefix",
        ],
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
    // Nothing here could resolve against the registry: no dist-tag spec was passed.
    expect(calls[0]!.args).not.toContain("@pocharlies/cli@latest");
  });

  test("installLatest on the official channel never touches the release API", async () => {
    let releaseCalls = 0;
    const calls: CommandCall[] = [];
    const cli = new DefaultNpmGlobalPaseoCli(
      async (command, args, options) => {
        calls.push({ command, args, timeout: options?.timeout, maxBuffer: options?.maxBuffer });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      {
        resolveLatestRelease: async () => {
          releaseCalls += 1;
          throw new Error("must not be called");
        },
      },
    );

    await cli.installLatest();
    expect(releaseCalls).toBe(0);
    expect(calls[0]!.args).toContain("@getpaseo/cli@latest");
  });

  test("inspectLatestRelease returns the release metadata for version discovery", async () => {
    const cli = new DefaultNpmGlobalPaseoCli(
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      {
        distribution: OWN_CHANNEL,
        resolveLatestRelease: async () => parseOwnRelease(FIXTURE_RELEASE, OWN_CHANNEL),
      },
    );
    await expect(cli.inspectLatestRelease()).resolves.toMatchObject({
      version: "0.12.1",
      upstreamVersion: "0.12.0",
    });
  });
});
