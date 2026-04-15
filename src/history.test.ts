import { describe, it, expect } from "vitest";
import { createHistory } from "./history.js";

describe("createHistory", () => {
  it("starts empty", () => {
    const history = createHistory();
    expect(history.getMessages()).toEqual([]);
  });

  it("adds messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" });
    history.add({ role: "assistant", content: "hi there" });
    const msgs = history.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "hi there" });
  });

  it("returns a copy of messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" });
    const copy = history.getMessages();
    copy.push({ role: "assistant", content: "mutated" });
    expect(history.getMessages()).toHaveLength(1);
  });

  it("clears all messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" });
    history.clear();
    expect(history.getMessages()).toEqual([]);
  });
});
