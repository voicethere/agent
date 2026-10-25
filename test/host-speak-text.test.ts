import { describe, expect, it } from "vitest";

import { estimatePlayedText } from "../src/host/speak-text.js";

describe("estimatePlayedText", () => {
  it("snaps to the previous word boundary", () => {
    // 50% of 33 chars = 17 (rounded), inside "morning"
    const r = estimatePlayedText(
      "Your order ships tomorrow morning.",
      500,
      1000,
    );
    expect(r.played).toBe("Your order ships");
    expect(r.unplayed).toBe("tomorrow morning.");
  });

  it("no boundary before the cut gives empty played text", () => {
    const r = estimatePlayedText("Supercalifragilistic words", 100, 1000);
    expect(r).toEqual({ played: "", unplayed: "Supercalifragilistic words" });
  });

  it("full and zero played ms", () => {
    expect(estimatePlayedText("Hello there", 1000, 1000)).toEqual({
      played: "Hello there",
      unplayed: "",
    });
    expect(estimatePlayedText("Hello there", 2000, 1000).unplayed).toBe("");
    expect(estimatePlayedText("Hello there", 0, 1000)).toEqual({
      played: "",
      unplayed: "Hello there",
    });
    expect(estimatePlayedText("Hello there", 500, 0)).toEqual({
      played: "",
      unplayed: "Hello there",
    });
  });
});
