import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The canonical skill lives at the repo root (so an agent browsing the repo finds
// it immediately). The plugin ships a copy at skills/maneki/SKILL.md. This guard
// keeps them identical: edit SKILL.md, then `npm run sync:skill`.
describe("skill copies stay in sync", () => {
  it("root SKILL.md matches the plugin copy (run `npm run sync:skill` if this fails)", () => {
    const root = readFileSync("SKILL.md", "utf8");
    const plugin = readFileSync("skills/maneki/SKILL.md", "utf8");
    expect(plugin).toBe(root);
  });
});
