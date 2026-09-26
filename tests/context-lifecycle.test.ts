import { describe, expect, it } from "vitest";
import { GraphicsContextLifecycle } from "../src/render/contextLifecycle";

describe("WebGL context lifecycle", () => {
  it("pauses on loss and resumes the same generation after restoration", () => {
    const lifecycle = new GraphicsContextLifecycle();
    lifecycle.lose();
    expect(lifecycle.available).toBe(false);
    expect(lifecycle.beginRestore()).toBe(true);
    expect(lifecycle.restored()).toBe(true);
    expect(lifecycle.available).toBe(true);
    expect(lifecycle.generation).toBe(1);
  });

  it("does not double-count duplicate browser events", () => {
    const lifecycle = new GraphicsContextLifecycle();
    lifecycle.lose();
    lifecycle.lose();
    lifecycle.beginRestore();
    lifecycle.beginRestore();
    lifecycle.restored();
    lifecycle.restored();
    expect(lifecycle.generation).toBe(1);
  });

  it("records restoration failure and allows a later retry", () => {
    const lifecycle = new GraphicsContextLifecycle();
    lifecycle.lose();
    lifecycle.beginRestore();
    lifecycle.fail(new Error("composer rebuild failed"));
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.error).toContain("composer");
    expect(lifecycle.beginRestore()).toBe(true);
    expect(lifecycle.restored()).toBe(true);
  });
});
