import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  sortThreadsByAgentActivity,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    // After a reset the next call is a fresh baseline again.
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      // A wake run requested after the other thread's send.
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    // Launched by an agent: no user message, so creation time is the send.
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("sortThreadsByAgentActivity", () => {
  const run = (requestedAt: string, completedAt: string | null) => ({
    runId: RunId.make(`run:${requestedAt}`),
    status: completedAt === null ? ("running" as const) : ("completed" as const),
    requestedAt,
    startedAt: requestedAt,
    completedAt,
    assistantMessageId: null,
  });

  it("puts the latest agent start or finish first, with idle threads by creation", () => {
    const finishedLate = {
      ...thread("finished-late", false),
      latestRun: run("2026-06-01T01:00:00.000Z", "2026-06-01T05:00:00.000Z"),
    };
    const startedRecently = {
      ...thread("started-recently", true),
      latestRun: run("2026-06-01T04:00:00.000Z", null),
    };
    const finishedEarly = {
      ...thread("finished-early", false),
      latestRun: run("2026-06-01T02:00:00.000Z", "2026-06-01T03:00:00.000Z"),
    };
    const fresh = { ...thread("fresh", false), createdAt: "2026-06-01T03:30:00.000Z" };
    expect(
      sortThreadsByAgentActivity([finishedEarly, fresh, startedRecently, finishedLate]).map(
        (thread) => thread.id,
      ),
    ).toEqual(["finished-late", "started-recently", "fresh", "finished-early"]);
  });
});
