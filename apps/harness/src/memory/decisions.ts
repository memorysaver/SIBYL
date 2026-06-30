import type { ExtensionAPI, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The `customType` tag under which decision-memory entries are stored in the Pi
 * session. It is the seam the L5 pluggable-backend swap will key off — keeping it
 * a named constant (rather than a bare string literal) marks that future swap
 * point without introducing an abstraction layer now.
 */
export const SIBYL_DECISION_ENTRY_TYPE = "sibyl-decision";

/**
 * A captured human decision made during a run — the decision-memory primitive
 * (`architecture.domain_model.DecisionEntry`).
 *
 * `at` is a caller-supplied timestamp: this module is pure pass-through logic and
 * never calls `Date.now()` itself.
 */
export interface DecisionEntry {
  /** Stable id for the decision (assigned by the caller / engine). */
  id: string;
  /** Run phase the decision was made in (e.g. `originate`). */
  phase: string;
  /** The choice the human made. */
  decision: string;
  /** Timestamp the decision was made (passed in, not generated here). */
  at: number;
}

/**
 * The narrow slice of `SessionManager` `recallDecisions` reads from. Accepts both
 * the full `SessionManager` (held by the engine) and the read-only
 * `ctx.sessionManager` handed to extension event handlers (e.g. on
 * `session_start`), since both expose `getEntries()`.
 */
type DecisionEntrySource = Pick<SessionManager, "getEntries">;

/**
 * Persist a decision to the session as a custom entry via `pi.appendEntry`.
 *
 * A thin pass-through: it wraps the Pi ExtensionAPI's
 * `appendEntry(customType, data)`, which stores a `type: "custom"` session entry
 * that is persisted to the session but **excluded from the LLM context** (Pi's
 * `buildSessionContext` ignores `custom` entries). No abstraction layer — this is
 * one of exactly two functions in this module until the L5 backend swap.
 */
export function appendDecision(pi: ExtensionAPI, entry: DecisionEntry): void {
  pi.appendEntry<DecisionEntry>(SIBYL_DECISION_ENTRY_TYPE, entry);
}

/**
 * Read back the decisions previously persisted to the session, in append order.
 *
 * Scans the session's entries for SIBYL's `custom` decision entries and returns
 * their payloads. Used by the engine to restore prior decisions when a session is
 * resumed (`session_start`).
 */
export function recallDecisions(source: DecisionEntrySource): DecisionEntry[] {
  return source
    .getEntries()
    .filter(isSibylDecisionEntry)
    .map((entry) => entry.data as DecisionEntry);
}

/** A persisted SIBYL decision entry: a `custom` session entry under our tag. */
function isSibylDecisionEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> & { data: DecisionEntry } {
  return (
    entry.type === "custom" &&
    entry.customType === SIBYL_DECISION_ENTRY_TYPE &&
    entry.data !== undefined
  );
}
