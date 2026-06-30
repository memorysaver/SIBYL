# Extraction prompts

The two opposing-pressure prompts that drive a forge pass. **Both are load-bearing — keep them exact, not paraphrased.** They are direct adaptations of NousResearch's hermes-agent curator prompts (see `agent/background_review.py` and `agent/curator.py` in that repo).

The point of the pair is to fight two opposite failure modes at once:

- **Capture pressure** keeps the pass active. Without it, a forge run shrugs and exits when the lessons look small or messy.
- **Umbrella pressure** keeps the library coherent. Without it, every lesson becomes a new top-level skill and the library degenerates into a flat list of one-shot entries.

Use both, in this order, in the forge prompt.

---

## Prompt A — Capture pressure ("be ACTIVE")

> You are running as the **skill capture** half of `memory-forge`. Review the lessons-learned files above and consider what to do with them.
>
> Be ACTIVE — most forge passes produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.
>
> If you decide there is genuinely nothing to consolidate, say so explicitly and name the reason (e.g. *"all 4 candidate lessons are below the 7-day pre-filter"*, *"no two lessons share a recurring theme yet"*). Silent no-op is not allowed.

This half is responsible for making sure the pass doesn't shrug. It pairs with the cheap pre-filter (`select_lessons.sh`) — if the pre-filter passes lessons through, the LLM should act on them, not throw them away again.

---

## Prompt B — Umbrella pressure ("flat list = failure")

> You are running as the **skill curator** half of `memory-forge`. This is an UMBRELLA-BUILDING consolidation pass.
>
> Target shape of the library: **class-level skills**, each with a rich `SKILL.md` and a `references/` directory for session-specific detail. Not a long flat list of narrow one-session-one-skill entries.
>
> A collection of hundreds of narrow skills where each one captures one session's specific bug is a FAILURE of the library — not a feature. Prefer:
>
> 1. **Merge into umbrella** — append the lesson(s) as a new `references/<topic>.md` file under an existing umbrella SKILL.md.
> 2. **Create new umbrella** — only when no existing umbrella covers the theme and at least 2 lessons share it. The new SKILL.md should be class-level (general enough to absorb future related lessons).
> 3. **Demote into references/** — if an existing skill is too narrow and a new umbrella now covers it, move the narrow one into the umbrella's `references/`.

This half is responsible for shape discipline. It pairs with the structured-summary requirement (see [structured-summary-schema.md](structured-summary-schema.md)) — the curator must declare which of these three actions it picked for each cluster.

---

## Scoring rubric (use during the pass)

For each cluster of lessons the forge is considering acting on, score it on these dimensions before deciding:

| Dimension | Strong signal | Weak signal |
|---|---|---|
| **Recurrence** | ≥2 lessons across ≥2 different days describe the same root cause | A single dramatic session |
| **Actionability** | A future agent can change behavior based on it (testable rule: "if X, do Y because Z") | Vague vibes ("be careful with auth") |
| **Generality** | The rule applies across multiple files / features / contexts | The rule only matters for one specific file or PR |
| **Counter-evidence** | No subsequent lesson contradicts it | A more recent lesson reverses the rule |

A cluster that scores **strong on Recurrence + Actionability** → bias toward action (consolidation or new umbrella).

A cluster that scores **strong on Generality but weak on Recurrence** → wait. One general-sounding lesson is not yet a pattern.

A cluster with **Counter-evidence** → do not consolidate. Route to [reconcile-conflicts.md](../workflows/reconcile-conflicts.md) instead.

---

## Required output

The pass MUST end with a `## Structured summary` block conforming to [structured-summary-schema.md](structured-summary-schema.md). That block is what `scripts/apply_forge.sh` parses. Free-form analysis above the structured summary is allowed and useful, but the structured block is non-optional.

If the structured summary is empty in all three arrays (`consolidations: []`, `new_skills: []`, `prunings: []`), the pass MUST include a top-level explanation of why, naming the specific pre-filter / clustering / scoring step that produced the empty result.
