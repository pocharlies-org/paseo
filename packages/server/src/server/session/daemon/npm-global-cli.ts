import { createWriteStream, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  DISTRIBUTION,
  OFFICIAL_DISTRIBUTION,
  type DistributionConfig,
} from "@getpaseo/protocol/distribution";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { execCommand } from "../../../utils/spawn.js";

// Both the global inspection and `installLatest` resolve through this one configured
// package (and its dist-tag), so a build never inspects one package and installs another.
export const PASEO_CLI_PACKAGE = DISTRIBUTION.npmCliPackage;

// An own build is one whose configured CLI package differs from the official one (exactly
// what set-distribution.mjs --own enforces fail-closed). Own builds install from the own
// GitHub release tarball, never from a registry: an own channel that resolved
// @getpaseo/* from npm would silently run official code.
export function isOwnReleaseChannel(config: DistributionConfig = DISTRIBUTION): boolean {
  return config.npmCliPackage !== OFFICIAL_DISTRIBUTION.npmCliPackage;
}

const NPM_PROBE_TIMEOUT_MS = 10_000;
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const NPM_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const RELEASE_PROBE_TIMEOUT_MS = 15_000;

// The tarball asset pack-own-release.mjs publishes for the own CLI (npm names scoped
// packages as <scope-without-@>-<name>-<version>.tgz).
export function ownCliTarballAssetName(config: DistributionConfig = DISTRIBUTION): string {
  return `${config.npmCliPackage.slice(1).replace("/", "-")}-`;
}

const GitHubReleaseAssetSchema = z
  .object({
    name: z.string(),
    browser_download_url: z.string(),
  })
  .passthrough();

const GitHubReleaseSchema = z
  .object({
    tag_name: z.string(),
    body: z.string().nullable().optional(),
    assets: z.array(GitHubReleaseAssetSchema).default([]),
  })
  .passthrough();

// The release metadata update-watch (dgx-infra) reads: `upstream: X.Y.Z` in the notes,
// or the tag itself as <X.Y.Z>[-suffix]. Version discovery reads the own release, never
// `npm view` / the registry, so an own build discovers its own channel.
const UPSTREAM_METADATA_RE = /upstream:\s*v?(\d+\.\d+\.\d+)/i;
const UPSTREAM_TAG_RE = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/;

export interface OwnReleaseInfo {
  /** Own release version (the tag, leading "v" stripped). */
  version: string;
  /** Upstream version this own release incorporates, from its metadata. */
  upstreamVersion: string | null;
  /** Download URL of the self-contained own CLI tarball asset. */
  tarballUrl: string;
}

export type FetchJson = (url: string) => Promise<unknown>;

export const defaultFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "paseo-daemon" },
    signal: AbortSignal.timeout(RELEASE_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status} for ${url}`);
  }
  return await response.json();
};

export function parseOwnRelease(
  release: unknown,
  config: DistributionConfig = DISTRIBUTION,
): OwnReleaseInfo {
  const parsed = GitHubReleaseSchema.parse(release);
  // Own release tags are "own-v<X.Y.Z>[-suffix]"; the version is the numeric part.
  const version = parsed.tag_name.replace(/^[a-z]+-v/, "").replace(/^v/, "");
  const fromBody = parsed.body ? UPSTREAM_METADATA_RE.exec(parsed.body)?.[1] : undefined;
  const upstreamVersion = fromBody ?? UPSTREAM_TAG_RE.exec(parsed.tag_name)?.[1] ?? null;
  const prefix = ownCliTarballAssetName(config);
  const asset = parsed.assets.find(
    (candidate) => candidate.name.startsWith(prefix) && candidate.name.endsWith(".tgz"),
  );
  if (!asset) {
    throw new Error(
      `Release ${parsed.tag_name} has no own CLI tarball asset (expected a name starting with "${prefix}")`,
    );
  }
  return { version, upstreamVersion, tarballUrl: asset.browser_download_url };
}

export async function resolveLatestOwnRelease(
  config: DistributionConfig = DISTRIBUTION,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<OwnReleaseInfo> {
  const url = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/releases/latest`;
  return parseOwnRelease(await fetchJson(url), config);
}

export type DownloadFile = (url: string, destination: string) => Promise<void>;

export const defaultDownloadFile: DownloadFile = async (url, destination) => {
  const response = await fetch(url, {
    headers: { "user-agent": "paseo-daemon" },
    signal: AbortSignal.timeout(NPM_INSTALL_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Own CLI tarball download failed: HTTP ${response.status} for ${url}`);
  }
  // The fetch ReadableStream type is slightly different from what Readable.fromWeb expects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destination));
};

const NpmGlobalListSchema = z
  .object({
    path: z.string().optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const NpmGlobalCliPackageSchema = z
  .object({
    version: z.string(),
    path: z.string(),
  })
  .passthrough();

const CommandErrorSchema = z
  .object({
    code: z.union([z.number(), z.string()]).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();

export interface CommandOptions {
  timeout?: number;
  maxBuffer?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NpmGlobalPaseoInstall {
  version: string;
  packagePath: string;
  globalRootPath: string | null;
  isLinked: boolean;
}

export interface NpmGlobalPaseoCli {
  inspect(options?: NpmGlobalOptions): Promise<NpmGlobalPaseoInstall>;
  installLatest(options?: NpmGlobalOptions): Promise<CommandResult>;
  inspectLatestRelease(): Promise<OwnReleaseInfo>;
}

export interface NpmGlobalCliDeps {
  distribution?: DistributionConfig;
  resolveLatestRelease?: (config: DistributionConfig) => Promise<OwnReleaseInfo>;
  downloadFile?: DownloadFile;
  /** Temp dir for the downloaded tarball; defaults to the system temp dir. */
  tempDir?: () => string;
}

interface NpmGlobalOptions {
  prefix?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

async function runExternalCommand(
  command: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execCommand(command, args, {
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const parsed = CommandErrorSchema.safeParse(error);
    if (!parsed.success) {
      return { exitCode: 1, stdout: "", stderr: getErrorMessage(error) };
    }

    return {
      exitCode: typeof parsed.data.code === "number" ? parsed.data.code : 1,
      stdout: parsed.data.stdout ?? "",
      stderr: parsed.data.stderr || getErrorMessage(error),
    };
  }
}

function parseNpmGlobalPaseoInstall(stdout: string): NpmGlobalPaseoInstall | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    return null;
  }

  const list = NpmGlobalListSchema.safeParse(parsedJson);
  if (!list.success) {
    return null;
  }

  const rawCliPackage = list.data.dependencies?.[PASEO_CLI_PACKAGE];
  const cliPackage = NpmGlobalCliPackageSchema.safeParse(rawCliPackage);
  if (!cliPackage.success) {
    return null;
  }

  return {
    version: cliPackage.data.version,
    packagePath: cliPackage.data.path,
    globalRootPath: list.data.path ?? null,
    // npm links an install by making its node_modules entry a symlink (a junction
    // on Windows), and `npm ls --json` reports no flag for it.
    isLinked: lstatSync(cliPackage.data.path).isSymbolicLink(),
  };
}

export class DefaultNpmGlobalPaseoCli implements NpmGlobalPaseoCli {
  private readonly distribution: DistributionConfig;
  private readonly resolveLatestRelease: (config: DistributionConfig) => Promise<OwnReleaseInfo>;
  private readonly downloadFile: DownloadFile;
  private readonly tempDir: () => string;

  constructor(
    private readonly runCommand: CommandRunner = runExternalCommand,
    deps: NpmGlobalCliDeps = {},
  ) {
    this.distribution = deps.distribution ?? DISTRIBUTION;
    this.resolveLatestRelease =
      deps.resolveLatestRelease ?? ((config) => resolveLatestOwnRelease(config));
    this.downloadFile = deps.downloadFile ?? defaultDownloadFile;
    this.tempDir = deps.tempDir ?? tmpdir;
  }

  async inspect(options: NpmGlobalOptions = {}): Promise<NpmGlobalPaseoInstall> {
    const prefixArgs = options.prefix ? ["--prefix", options.prefix] : [];
    const result = await this.runCommand(
      "npm",
      ["-g", "ls", PASEO_CLI_PACKAGE, "--json", "--depth=0", "--long", ...prefixArgs],
      {
        timeout: NPM_PROBE_TIMEOUT_MS,
        maxBuffer: NPM_MAX_BUFFER_BYTES,
      },
    );

    if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
      throw new Error(result.stderr.trim() || "npm is not available on this host");
    }

    const install = parseNpmGlobalPaseoInstall(result.stdout);
    if (!install) {
      throw new Error(`${PASEO_CLI_PACKAGE} is not installed with npm -g on this host`);
    }
    return install;
  }

  async installLatest(options: NpmGlobalOptions = {}): Promise<CommandResult> {
    const prefixArgs = options.prefix ? ["--prefix", options.prefix] : [];
    if (isOwnReleaseChannel(this.distribution)) {
      // Own channel: install the self-contained tarball of the latest own release. The
      // tarball bundles its whole production closure, so nothing resolves against the
      // public registry (an own daemon must never end up running the official server).
      const release = await this.resolveLatestRelease(this.distribution);
      const tarball = path.join(this.tempDir(), `paseo-own-cli-${release.version}.tgz`);
      await this.downloadFile(release.tarballUrl, tarball);
      return this.runCommand("npm", ["install", "-g", tarball, ...prefixArgs], {
        timeout: NPM_INSTALL_TIMEOUT_MS,
        maxBuffer: NPM_MAX_BUFFER_BYTES,
      });
    }
    const spec = `${this.distribution.npmCliPackage}@${this.distribution.npmCliDistTag}`;
    return this.runCommand("npm", ["install", "-g", spec, ...prefixArgs], {
      timeout: NPM_INSTALL_TIMEOUT_MS,
      maxBuffer: NPM_MAX_BUFFER_BYTES,
    });
  }

  inspectLatestRelease(): Promise<OwnReleaseInfo> {
    return this.resolveLatestRelease(this.distribution);
  }
}

export const npmGlobalPaseoCli = new DefaultNpmGlobalPaseoCli();
