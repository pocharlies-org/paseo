import { expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

// Fork (DGX-1596): upstream #6904 offers Auto on hosted providers; this fork keeps Auto
// for the Anthropic API only, so Bedrock and Vertex hide it and reject an explicit pick.
const hostedEnvironments = [
  { transport: "Bedrock", env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
  { transport: "Vertex", env: { CLAUDE_CODE_USE_VERTEX: "true" } },
];

test.each(hostedEnvironments)(
  "hides Auto mode on $transport and keeps its default mode",
  async ({ env }) => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env },
      resolveVersion: async () => "2.1.263",
      discoverModels: async () => [],
    });

    const catalog = await client.fetchCatalog({ cwd: process.cwd() });

    expect(catalog.modes?.map((mode) => mode.id)).not.toContain("auto");
    expect(catalog.defaultModeId).toBe("default");
  },
);

test.each(hostedEnvironments)(
  "rejects an explicit Auto selection on $transport before reaching Claude Code",
  async ({ transport, env }) => {
    let requestedMode: string | undefined;
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env },
      resolveBinary: async () => "/test/claude",
      queryFactory: ({ options }) => {
        requestedMode = options.permissionMode;
        throw new Error("Claude Code must not be launched");
      },
    });
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

    try {
      await expect(session.setMode("auto")).rejects.toThrow(
        `Claude Auto mode requires the Anthropic API and is not supported when Claude Code uses ${transport}`,
      );
      expect(requestedMode).toBeUndefined();
    } finally {
      await session.close();
    }
  },
);
