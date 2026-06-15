import { describe, it, expect } from "vitest";
import { isFullName } from "../src/directory.ts";

describe("isFullName (join guard)", () => {
  it("accepts a real first + last name", () => {
    expect(isFullName("Sylve Chevet")).toBe(true);
    expect(isFullName("Oshyan Greene")).toBe(true);
  });
  it("rejects a lone first name or nickname (the Chase case)", () => {
    expect(isFullName("Chase")).toBe(false);
    expect(isFullName("")).toBe(false);
    expect(isFullName("   ")).toBe(false);
  });
  it("treats single-letter tokens as not a name part", () => {
    expect(isFullName("J Smith")).toBe(false);
    expect(isFullName("Jo Smith")).toBe(true);
  });
});
