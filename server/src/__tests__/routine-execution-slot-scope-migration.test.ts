import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("migration 0394 routine execution slot scope", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ale-2210-migration-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

/**
 * The unique-violation surfaces on the driver's error `cause` (constraint
 * name) rather than in the wrapped message, so assert on the structured
 * constraint the way the routine dispatch path does.
 */
async function expectUniqueViolation(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow();
  try {
    await promise;
    throw new Error("expected a unique violation");
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string; code?: string } }).cause;
    expect(cause?.constraint).toBe("issues_open_routine_execution_uq");
    expect(cause?.code).toBe("23505");
  }
}

  async function seedLiveRun() {
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: null },
    });
    return heartbeatRunId;
  }

  it("adds the slot columns to issues and routine_runs", async () => {
    const issueCols = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'issues' and column_name in ('origin_slot_key','origin_trigger_id') order by column_name`,
    );
    expect(issueCols.map((r) => r.column_name)).toEqual(["origin_slot_key", "origin_trigger_id"]);

    const runCols = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'routine_runs' and column_name = 'slot_key'`,
    );
    expect(runCols.map((r) => r.column_name)).toEqual(["slot_key"]);
  });

  it("rebuilds the open-execution unique index with the coalesced slot key", async () => {
    const idx = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'issues_open_routine_execution_uq'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef.toLowerCase()).toContain("coalesce");
    expect(idx[0]!.indexdef).toContain("origin_slot_key");
  });

  it("allows two different slots of one routine to hold open wrappers concurrently", async () => {
    const routineId = randomUUID();
    const hbA = await seedLiveRun();
    const hbB = await seedLiveRun();

    await db.insert(issues).values({
      companyId,
      identifier: `${issuePrefix}-1`,
      title: "slot A wrapper",
      description: "x",
      status: "in_progress",
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: "same-fingerprint",
      originSlotKey: "t:trigger-a:2026-10-25T08:00@America/New_York",
      originTriggerId: "trigger-a",
      executionRunId: hbA,
    });

    // A different slot of the same routine must be able to coexist.
    await expect(
      db.insert(issues).values({
        companyId,
        identifier: `${issuePrefix}-2`,
        title: "slot B wrapper",
        description: "x",
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: "same-fingerprint",
        originSlotKey: "t:trigger-b:2026-10-25T19:00@America/New_York",
        originTriggerId: "trigger-b",
        executionRunId: hbB,
      }),
    ).resolves.toBeDefined();

    // But the SAME slot must still be exclusive (the duplicate-wake guard).
    await expectUniqueViolation(
      db.insert(issues).values({
        companyId,
        identifier: `${issuePrefix}-3`,
        title: "slot A duplicate",
        description: "x",
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: "same-fingerprint",
        originSlotKey: "t:trigger-a:2026-10-25T08:00@America/New_York",
        originTriggerId: "trigger-a",
        executionRunId: hbB,
      }),
    ).catch((error) => error);
  });

  it("keeps legacy slot-less rows mutually exclusive", async () => {
    const routineId = randomUUID();
    const hbA = await seedLiveRun();
    const hbB = await seedLiveRun();

    await db.insert(issues).values({
      companyId,
      identifier: `${issuePrefix}-4`,
      title: "legacy wrapper",
      description: "x",
      status: "in_progress",
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: "same-fingerprint",
      originSlotKey: null,
      originTriggerId: null,
      executionRunId: hbA,
    });

    await expectUniqueViolation(
      db.insert(issues).values({
        companyId,
        identifier: `${issuePrefix}-5`,
        title: "legacy wrapper duplicate",
        description: "x",
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: "same-fingerprint",
        originSlotKey: null,
        originTriggerId: null,
        executionRunId: hbB,
      }),
    ).catch((error) => error);
  });
});
