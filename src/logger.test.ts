import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("logs at or above configured level", () => {
    const logs: string[] = [];
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    const capture = (...args: unknown[]) => logs.push(args.join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;

    const logger = createLogger("warn");
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("warn msg");
    expect(logs[1]).toContain("error msg");
  });
});
