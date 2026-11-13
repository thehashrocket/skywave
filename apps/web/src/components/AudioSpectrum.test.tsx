// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioSpectrum, audioYs, shownBins } from "./AudioSpectrum";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AudioSpectrum", () => {
  // Value: protects=the spectrum stops where the radio's audio ends (half its rate), whatever rate the browser runs the audio at, and never asks for bins that don't exist; fails_when=a 48 kHz context shows 24 kHz of empty spectrum, or the count passes the analyser's bins; why_new=audio spectrum; seam=none; no_claim=none
  it("shows bins up to the radio's audio, at any context rate", () => {
    expect(shownBins(512, 12_000, 6_000)).toBe(512);
    expect(shownBins(512, 48_000, 6_000)).toBe(128);
    expect(shownBins(512, 8_000, 6_000)).toBe(512);
  });

  // Value: protects=levels map -100 dBFS to the bottom and -20 to the top, clamped, and a silent bin (-Infinity) lies flat instead of breaking the line; fails_when=the scale flips, runs off the canvas, or NaN reaches the path; why_new=audio spectrum; seam=none; no_claim=none
  it("places levels in its window, with silence at the bottom", () => {
    const ys = audioYs(Float32Array.from([-120, -100, -60, -20, 0, -Infinity]), 6, 56);
    expect(Array.from(ys)).toEqual([56, 56, 28, 0, 0, 56]);
  });

  // Value: protects=the spectrum draws from the analyser on each animation frame while audio plays, and stops (no frames, a blank canvas) when it doesn't; fails_when=it draws while stopped, keeps its animation running after, or never reads the analyser; why_new=audio spectrum; seam=canvas, analyser and requestAnimationFrame faked; no_claim=what the line looks like (browser check)
  it("draws each frame while active and stops when not", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const stroke = vi.fn();
    const ctx = {
      clearRect: vi.fn(),
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke,
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const read = vi.fn((a: Float32Array) => a.fill(-60));
    const analyser = { frequencyBinCount: 512, context: { sampleRate: 12_000 }, getFloatFrequencyData: read };
    const getAnalyser = () => analyser as unknown as AnalyserNode;

    const view = render(<AudioSpectrum getAnalyser={getAnalyser} active={false} sampleRate={12_000} />);
    expect(frames).toHaveLength(0);

    view.rerender(<AudioSpectrum getAnalyser={getAnalyser} active sampleRate={12_000} />);
    act(() => frames.shift()!(0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(stroke).toHaveBeenCalledTimes(1);

    ctx.clearRect.mockClear();
    view.rerender(<AudioSpectrum getAnalyser={getAnalyser} active={false} sampleRate={12_000} />);
    expect(cancel).toHaveBeenCalled();
    expect(ctx.clearRect).toHaveBeenCalled();
  });

  // Value: protects=the axis runs 0 to the audio's top in kHz, the last tick naming the unit; fails_when=ticks pass the audio's edge or the unit goes; why_new=audio spectrum; seam=none; no_claim=tick placement on screen (CSS)
  it("labels 0 to the top of the audio in kHz", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const view = render(<AudioSpectrum getAnalyser={() => null} active={false} sampleRate={12_000} />);
    const ticks = Array.from(view.container.querySelectorAll(".audio-spectrum-axis > span"), (s) => s.textContent);
    expect(ticks).toEqual(["0", "1", "2", "3", "4", "5", "6 kHz"]);
  });
});
