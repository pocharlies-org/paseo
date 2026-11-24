import { DISTRIBUTION } from "@getpaseo/protocol/distribution";
import { PackageVersionResolutionError, resolvePackageVersion } from "./package-version.js";

// The same configured package install-origin and local-daemon resolve; never a literal,
// so an own build reports its own version instead of failing to find the official name.
const SERVER_PACKAGE_NAME = DISTRIBUTION.npmServerPackage;

export class DaemonVersionResolutionError extends PackageVersionResolutionError {}

export function resolveDaemonVersion(moduleUrl: string = import.meta.url): string {
  try {
    return resolvePackageVersion({
      moduleUrl,
      packageName: SERVER_PACKAGE_NAME,
    });
  } catch (error) {
    if (error instanceof PackageVersionResolutionError) {
      throw new DaemonVersionResolutionError({
        moduleUrl,
        packageName: SERVER_PACKAGE_NAME,
      });
    }
    throw error;
  }
}
