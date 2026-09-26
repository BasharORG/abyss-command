export type GraphicsContextState = "ready" | "lost" | "restoring" | "failed";

/** Pure lifecycle state used by WorldView and covered without a browser GL context. */
export class GraphicsContextLifecycle {
  state: GraphicsContextState = "ready";
  generation = 0;
  error: string | null = null;

  lose() {
    if (this.state === "lost") return;
    this.state = "lost";
    this.error = null;
  }

  beginRestore() {
    if (this.state !== "lost" && this.state !== "failed") return false;
    this.state = "restoring";
    this.error = null;
    return true;
  }

  restored() {
    if (this.state !== "restoring") return false;
    this.state = "ready";
    this.generation++;
    return true;
  }

  fail(error: unknown) {
    this.state = "failed";
    this.error = error instanceof Error ? error.message : String(error);
  }

  get available() {
    return this.state === "ready";
  }
}
