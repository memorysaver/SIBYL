import { fileURLToPath } from "node:url";

import {
  buildSessionContext,
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { bootSession } from "../src/engine/session";
import {
  appendDecision,
  recallDecisions,
  SIBYL_DECISION_ENTRY_TYPE,
  type DecisionEntry,
} from "../src/memory/decisions";

// The harness package dir. Skill/extension discovery walks up to the git root.
const cwd = fileURLToPath(new URL("..", import.meta.url));

/**
 * Boot an in-memory session whose engine-extension captures the real Pi
 * `ExtensionAPI`, so tests drive `appendDecision` through the genuine
 * `pi.appendEntry` path (not a stub). Reuses SIBYL-001's `bootSession`.
 */
async function bootWithCapturedPi(sessionManager: SessionManager) {
  let pi: ExtensionAPI | undefined;
  const captureFactory: ExtensionFactory = (api: ExtensionAPI) => {
    pi = api;
  };
  const { session } = await bootSession(cwd, {
    sessionManager,
    extensionFactories: [captureFactory],
  });
  if (!pi) throw new Error("Pi ExtensionAPI was not captured during boot");
  return { session, pi };
}

const entryA: DecisionEntry = {
  id: "dec-a",
  phase: "originate",
  decision: "Commit the README",
  at: 1_719_000_000_000,
};
const entryB: DecisionEntry = {
  id: "dec-b",
  phase: "originate",
  decision: "Revise the vision",
  at: 1_719_000_111_111,
};

describe("decision memory (unit)", () => {
  it("appendDecision persists a DecisionEntry via pi.appendEntry; recallDecisions round-trips", async () => {
    const sm = SessionManager.inMemory(cwd);
    const { session, pi } = await bootWithCapturedPi(sm);

    try {
      // Nothing recalled before anything is appended.
      expect(recallDecisions(sm)).toEqual([]);

      appendDecision(pi, entryA);

      // AC1: it persisted as a real `custom` session entry under our tag, with
      // the DecisionEntry as its data — i.e. it went through pi.appendEntry.
      const persisted = sm
        .getEntries()
        .filter((e) => e.type === "custom" && e.customType === SIBYL_DECISION_ENTRY_TYPE);
      expect(persisted).toHaveLength(1);
      expect((persisted[0] as { data: unknown }).data).toEqual(entryA);

      // AC2 (round-trip): recall reads it back.
      expect(recallDecisions(sm)).toEqual([entryA]);

      // Multiple decisions are returned in append order.
      appendDecision(pi, entryB);
      expect(recallDecisions(sm)).toEqual([entryA, entryB]);
    } finally {
      await session.dispose();
    }
  });
});

describe("decision memory (integration)", () => {
  it("a decision survives a session_start restore: append in one session, recall in the next", async () => {
    // A single in-memory SessionManager is the persisted store across sessions.
    const sm = SessionManager.inMemory(cwd);

    // Session 1: capture pi, append a decision, then dispose (end of run).
    const first = await bootWithCapturedPi(sm);
    appendDecision(first.pi, entryA);
    await first.session.dispose();

    // Session 2: a fresh boot over the same session ("session_start" restore).
    // The engine's restore path reads decisions back via ctx.sessionManager,
    // whose `getEntries()` surface `recallDecisions` consumes.
    const second = await bootSession(cwd, { sessionManager: sm });
    try {
      expect(recallDecisions(sm)).toEqual([entryA]);
    } finally {
      await second.session.dispose();
    }
  });
});

describe("decision memory (excluded-from-LLM-context)", () => {
  it("appended decisions never enter the session context sent to the LLM", async () => {
    const sm = SessionManager.inMemory(cwd);
    const { session, pi } = await bootWithCapturedPi(sm);

    try {
      appendDecision(pi, entryA);

      // The decision is stored as a `custom` entry — the entry kind Pi documents
      // as excluded from the LLM context (ignored by buildSessionContext).
      const stored = sm
        .getEntries()
        .filter((e) => e.type === "custom" && e.customType === SIBYL_DECISION_ENTRY_TYPE);
      expect(stored).toHaveLength(1);

      // Behavioral proof: build the exact context Pi would send to the model and
      // assert none of the decision's payload leaks into it.
      const context = buildSessionContext(sm.getEntries());
      const serialized = JSON.stringify(context.messages);
      expect(serialized).not.toContain(entryA.decision);
      expect(serialized).not.toContain(entryA.id);
      expect(serialized).not.toContain(SIBYL_DECISION_ENTRY_TYPE);
    } finally {
      await session.dispose();
    }
  });
});
