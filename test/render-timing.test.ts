import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatToolDuration,
  startToolTiming,
  type ToolTimingState,
  updateToolTiming,
} from "../extensions/web-tools/shared.ts";

describe("tool render timing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts when execution begins and formats elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state: ToolTimingState = {};

    startToolTiming(state, false);
    expect(state.startedAt).toBeUndefined();

    startToolTiming(state, true);
    vi.setSystemTime(2_250);
    expect(formatToolDuration(state)).toBe("1.3s");
  });

  it("invalidates once per second while partial", () => {
    vi.useFakeTimers();
    const state: ToolTimingState = {};
    const invalidate = vi.fn();

    startToolTiming(state, true);
    updateToolTiming(state, true, false, invalidate);
    vi.advanceTimersByTime(2_000);

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("freezes elapsed time and clears its interval when settled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state: ToolTimingState = {};
    const invalidate = vi.fn();

    startToolTiming(state, true);
    updateToolTiming(state, true, false, invalidate);
    vi.setSystemTime(3_400);
    updateToolTiming(state, false, false, invalidate);
    vi.setSystemTime(8_000);
    vi.advanceTimersByTime(2_000);

    expect(formatToolDuration(state)).toBe("2.4s");
    expect(invalidate).not.toHaveBeenCalled();
    expect(state.interval).toBeUndefined();
  });
});
