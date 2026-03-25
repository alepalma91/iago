import { describe, expect, it } from "bun:test";

describe("smoke", () => {
  it("should run tests with bun", () => {
    expect(1 + 1).toBe(2);
  });
});
