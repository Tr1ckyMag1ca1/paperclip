import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
            };
          }
          return {
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve(runOverrides === null ? [] : [{
                id: "11111111-1111-4111-8111-111111111111",
                companyId: "22222222-2222-4222-8222-222222222222",
                agentId: "33333333-3333-4333-8333-333333333333",
                responsibleUserId: "user-1",
                contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
                ...runOverrides,
              }]),
            }),
          };
        },
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
        if (value.action === "issue.cross_issue_influence_observed") observedCount += 1;
      },
    }),
  };
  return {
    db: {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    },
    inserted,
    get observedCount() {
      return observedCount;
    },
  };
}

describe("cross-issue influence limit rollout", () => {
  it("logs observations without enforcement during the one-week rollout", () => {
    const decision = evaluateCrossIssueInfluenceLimit({
      priorCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: "log_only",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });
  });

  it("allows the twentieth influence and fails closed on the twenty-first after the flip", () => {
    const now = CROSS_ISSUE_INFLUENCE_ENFORCE_AT;
    expect(evaluateCrossIssueInfluenceLimit({ priorCount: 19, now })).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 20,
      cap: 20,
    });

    const rejected = evaluateCrossIssueInfluenceLimit({ priorCount: 20, now });
    expect(rejected).toMatchObject({
      allowed: false,
      mode: "enforce",
      count: 21,
      cap: 20,
    });
    const capError = crossIssueInfluenceLimitError(rejected, {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    expect(capError.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: 20,
      count: 21,
      mode: "enforce",
      enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
    });
    // Plan §6: the 429 names the boundary, who can act, and the way forward.
    expect(capError.error).toContain("20");
    expect(capError.error).toContain("Who can act:");
    expect(capError.error).toContain("Try this:");
    expect(capError.error).toContain("next heartbeat");
    expect(capError.details.boundary).toContain("20");
    expect(capError.details.whoCanAct).toContain("Fable");
  });

  it("uses one durable counter for cross-issue comments, PATCH updates, and interaction resolutions", async () => {
    const fake = counterDb();
    const base = {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    } as const;

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toMatchObject({ count: 2, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "interaction_resolution" }))
      .resolves.toMatchObject({ count: 3, allowed: true });

    expect(fake.observedCount).toBe(3);
    expect(fake.inserted.map((row) => (row.details as { kind: string }).kind))
      .toEqual(["comment", "update", "interaction_resolution"]);
  });

  it("counts an interaction resolution against a budget already spent on comments", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "interaction_resolution",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("does not count same-issue writes", async () => {
    const fake = counterDb(0, {
      contextSnapshot: { issueId: "55555555-5555-4555-8555-555555555555" },
    });
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["wrong-agent", { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["wrong-company", { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ] as const)("fails closed for a %s locked run", async (_label, runOverrides) => {
    const fake = counterDb(0, runOverrides);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed before querying for a malformed run id", async () => {
    const fake = counterDb();

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "attacker-controlled-run-id",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("counts writes from an unscoped run instead of rejecting them", async () => {
    // A timer heartbeat with no checked-out issue has no source issue: every
    // write it makes is cross-issue by definition. The persisted run row is
    // still the attribution anchor, so the write spends the cap rather than
    // failing as run-less.
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
    })).resolves.toMatchObject({ count: 1, allowed: true });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId: null }),
      }),
    ]);
  });

  it("still caps an unscoped run once its budget is spent", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });
  // A bare `heartbeat_timer` run has no source issue, so
  // the source comparison can never match and every issue write it made spent
  // the cap — including writes to the very issue routed to that agent. The
  // assignee short-circuit keeps an agent inside the boundary of its own work.
  describe("assignee short-circuit for unscoped runs", () => {
    const AGENT = "33333333-3333-4333-8333-333333333333";
    const OTHER_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const noSource = { contextSnapshot: {} };

    it("allows an unscoped run to write to an issue it is the assignee of", async () => {
      const fake = counterDb(0, noSource);

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        agentId: AGENT,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
        targetAssigneeAgentId: AGENT,
        kind: "comment",
      })).resolves.toBeNull();

      // Returning null means "in boundary": nothing is counted.
      expect(fake.inserted).toEqual([]);
      expect(fake.observedCount).toBe(0);
    });

    it("still counts an unscoped run writing to an issue assigned to someone else", async () => {
      const fake = counterDb(0, noSource);

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        agentId: AGENT,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
        targetAssigneeAgentId: OTHER_AGENT,
        kind: "comment",
      })).resolves.toMatchObject({ count: 1, allowed: true });

      expect(fake.inserted).toHaveLength(1);
    });

    it("still counts an unscoped run writing to an unassigned issue", async () => {
      const fake = counterDb(0, noSource);

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        agentId: AGENT,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
        targetAssigneeAgentId: null,
        kind: "update",
      })).resolves.toMatchObject({ count: 1, allowed: true });

      expect(fake.inserted).toHaveLength(1);
    });

    it("does not let an unscoped assignee escape the cap once it is exhausted", async () => {
      const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, noSource);

      // The assignee's own writes are never counted, so they can never push a
      // run to the cap — but genuine cross-issue writes still get rejected.
      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        agentId: AGENT,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
        targetAssigneeAgentId: OTHER_AGENT,
        kind: "comment",
        now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT),
      })).resolves.toMatchObject({ allowed: false });

      expect(fake.inserted).toEqual([
        expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
      ]);
    });

    it("keeps a source-stamped run on its source issue even when it is not the assignee", async () => {
      const fake = counterDb(0, {
        contextSnapshot: { issueId: "55555555-5555-4555-8555-555555555555" },
      });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        agentId: AGENT,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
        targetAssigneeAgentId: OTHER_AGENT,
        kind: "comment",
      })).resolves.toBeNull();

      expect(fake.inserted).toEqual([]);
    });

    it("does not exempt an assignee from a genuine cross-issue write", async () => {
      // Source is issue A; the agent is the assignee of issue B. Assigning
      // yourself a target issue must not buy unlimited influence over others.
      const fake = counterDb(0, {
        contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
      });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        agentId: AGENT,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
        targetAssigneeAgentId: AGENT,
        kind: "comment",
      })).resolves.toMatchObject({ count: 1, allowed: true });

      expect(fake.inserted).toHaveLength(1);
    });
  });
});
