import { describe, expect, it } from "vitest";

import { textBlockLine } from "../src/cli.js";

describe("textBlockLine", () => {
  it("says the text with its marker", () => {
    expect(textBlockLine("Reading the repo.")).toBe("· Reading the repo.");
  });

  it("says nothing for an empty block", () => {
    expect(textBlockLine("")).toBeNull();
  });

  it("says nothing for a whitespace-only block", () => {
    expect(textBlockLine("\n")).toBeNull();
    expect(textBlockLine("   \n\t ")).toBeNull();
  });
});
