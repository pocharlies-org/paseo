import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

interface ScheduleSeedClient {
  scheduleCreate(input: {
    prompt: string;
    name?: string;
    cadence: { type: "cron"; expression: string };
    target:
      | { type: "agent"; agentId: string }
      | {
          type: "new-agent";
          config: {
            provider: "mock";
            cwd: string;
            model: string;
            modeId: string;
            title: string;
          };
        };
    runOnCreate: boolean;
  }): Promise<{ schedule: { id: string } | null; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function createSchedule(
  workspace: SeededWorkspace,
  input: Parameters<ScheduleSeedClient["scheduleCreate"]>[0],
): Promise<string> {
  const client = workspace.client as unknown as ScheduleSeedClient;
  const result = await client.scheduleCreate(input);
  if (!result.schedule) {
    throw new Error(result.error ?? "Failed to seed schedule");
  }
  return result.schedule.id;
}

test("Schedules shows an Archived tab and filters rows by workspace", async ({ page }) => {
  // Two seeded workspaces plus a cold Metro bundle need more than the 60 s default.
  test.setTimeout(240_000);
  const main = await seedWorkspace({ repoPrefix: "sched-arch-" });
  const other = await seedWorkspace({ repoPrefix: "sched-arch-other-" });
  const scheduleIds: Array<{ workspace: SeededWorkspace; id: string }> = [];
  try {
    // An agent-target schedule on the main workspace whose agent gets archived.
    const agent = await main.client.createAgent({
      provider: "mock",
      cwd: main.repoPath,
      workspaceId: main.workspaceId,
      title: "Archived target",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    scheduleIds.push({
      workspace: main,
      id: await createSchedule(main, {
        prompt: "Archived target check.",
        name: "Archived schedule",
        cadence: { type: "cron", expression: "0 9 * * *" },
        target: { type: "agent", agentId: agent.id },
        runOnCreate: false,
      }),
    });
    await main.client.archiveAgent(agent.id);

    // An active schedule on the other workspace so the filter has two options.
    scheduleIds.push({
      workspace: other,
      id: await createSchedule(other, {
        prompt: "Active on the other workspace.",
        name: "Other workspace schedule",
        cadence: { type: "cron", expression: "0 9 * * *" },
        target: {
          type: "new-agent",
          config: {
            provider: "mock",
            cwd: other.repoPath,
            model: "ten-second-stream",
            modeId: "load-test",
            title: "Other workspace schedule",
          },
        },
        runOnCreate: false,
      }),
    });

    await gotoAppShell(page);
    await page.goto(buildSchedulesRoute());

    // Active tab: the active schedule is listed, the archived one is not.
    await expect(page.getByText("Other workspace schedule", { exact: true })).toBeVisible();
    await expect(page.getByText("Archived schedule", { exact: true })).toHaveCount(0);

    // Workspace filter lists both workspaces while still on Active. The
    // archived agent is not in the daemon directory, so its row only names a
    // workspace once the screen has fetched the agent by id.
    const trigger = page.getByTestId("schedules-workspace-filter-trigger");
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.click();
    const popup = page.getByTestId("combobox-desktop-container");
    await expect(popup).toBeVisible();
    await popup.getByText(new RegExp(other.projectDisplayName)).first().click();
    await expect(page.getByText("Other workspace schedule", { exact: true })).toBeVisible();
    await expect(page.getByText("Archived schedule", { exact: true })).toHaveCount(0);
    await trigger.click();
    await popup.getByText("All workspaces").first().click();

    // Archived tab exists and holds the archived schedule.
    await page.getByTestId("schedules-filter-archived").click();
    await expect(page.getByText("Archived schedule", { exact: true })).toBeVisible();
    await expect(page.getByText("Other workspace schedule", { exact: true })).toHaveCount(0);

    // Filtering by the other workspace excludes the archived row.
    await trigger.click();
    await popup.getByText(new RegExp(other.projectDisplayName)).first().click();
    await expect(page.getByText("Archived schedule", { exact: true })).toHaveCount(0);
    await page.getByTestId("schedules-filter-active").click();
    await expect(page.getByText("Other workspace schedule", { exact: true })).toBeVisible();
  } finally {
    for (const { workspace, id } of scheduleIds) {
      const client = workspace.client as unknown as ScheduleSeedClient;
      await client.scheduleDelete({ id }).catch(() => undefined);
    }
    await other.cleanup();
    await main.cleanup();
  }
});
