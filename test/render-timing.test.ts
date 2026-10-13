import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../extensions/web-tools/fetch.ts";
import {
  formatElapsed,
  startToolTiming,
  type ToolTimingState,
  updateToolTiming,
} from "../extensions/web-tools/shared.ts";

describe("tool render timing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts elapsed time from the start of execution", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state: ToolTimingState = {};

    startToolTiming(state, false);
    expect(state.startedAt).toBeUndefined();

    startToolTiming(state, true);
    vi.setSystemTime(2_250);
    startToolTiming(state, true);
    expect(formatElapsed(state)).toBe("1.3s");
  });

  it("invalidates once per second while partial and stops on the final result", () => {
    vi.useFakeTimers();
    const state: ToolTimingState = {};
    const invalidate = vi.fn();

    startToolTiming(state, true);
    updateToolTiming(state, true, invalidate);
    updateToolTiming(state, true, invalidate);
    vi.advanceTimersByTime(2_000);
    expect(invalidate).toHaveBeenCalledTimes(2);

    updateToolTiming(state, false, invalidate);
    vi.advanceTimersByTime(2_000);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(state.interval).toBeUndefined();
  });

  it("shows the recorded duration of a final result, not the render clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const tool = createWebFetchTool([]);
    const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    const state: ToolTimingState = {};
    startToolTiming(state, true);
    vi.setSystemTime(60_000);

    const component = tool.renderResult?.(
      { content: [{ type: "text", text: "boom" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      { state, isError: true, durationMs: 3_460, invalidate: vi.fn() } as never,
    );

    expect(component?.render(80).join("\n")).toContain("Extracted in 3.5s");
  });
});
