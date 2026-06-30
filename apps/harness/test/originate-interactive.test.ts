/**
 * Tests for the interactive-TUI support added to close the Layer-0 gap: the
 * offline, prompt-driven `connect` port that lets the live modal form show a
 * README reflecting whatever the user typed — with NO live model.
 *
 * The live `runOriginateInteractive` path itself mounts a real pi-tui `TUI`
 * (raw TTY) and is verified by running `sibyl originate --tui` in a real
 * terminal (the L0.5 ux-flow calibration surface). Here we test the deterministic
 * offline pieces it is built from.
 */

import { describe, expect, it } from "vitest";

import { buildImaginePrompt } from "../src/engine/originate";
import { createPromptDrivenConnect, valuesFromPrompt } from "../src/main";

describe("interactive originate — offline prompt-driven agent", () => {
  it("valuesFromPrompt recovers the form values embedded in an imagine prompt", () => {
    const values = {
      product: "SIBYL",
      problem: "align AEP across a team",
      vision: "a TUI harness",
    };
    expect(valuesFromPrompt(buildImaginePrompt(values))).toEqual(values);
  });

  it("falls back to (unspecified) for empty fields (mirrors buildImaginePrompt)", () => {
    const recovered = valuesFromPrompt(buildImaginePrompt({}));
    expect(recovered).toEqual({
      product: "(unspecified)",
      problem: "(unspecified)",
      vision: "(unspecified)",
    });
  });

  it("the prompt-driven connect streams a README reflecting the typed values", async () => {
    const connect = createPromptDrivenConnect();
    const session = await connect("/tmp/ignored", new AbortController().signal);

    const deltas: string[] = [];
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        deltas.push(event.assistantMessageEvent.delta);
      }
    });

    await session.prompt(
      buildImaginePrompt({
        product: "MyApp",
        problem: "no guided flow",
        vision: "make it legible",
      }),
    );

    const readme = deltas.join("");
    expect(readme).toContain("# MyApp");
    expect(readme).toContain("no guided flow");
    expect(readme).toContain("make it legible");

    session.dispose();
  });

  it("yields a fresh session per connection (no shared mutable script)", async () => {
    const connect = createPromptDrivenConnect();
    const a = await connect("/tmp/a", new AbortController().signal);
    const b = await connect("/tmp/b", new AbortController().signal);
    expect(a).not.toBe(b);
  });
});
