/**
 * normalize.test.ts — 消息标准化模块测试
 *
 * 测试三个标准化功能：
 * 1. 元数据字段过滤（_ 开头的键）
 * 2. 缺失 tool_result 的补全
 * 3. 连续同角色消息的合并
 */

import { describe, it, expect } from "vitest";
import { normalizeMessages } from "./normalize.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * 元数据过滤测试
 */
describe("normalizeMessages - metadata filtering", () => {
  it("keeps string content unchanged", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "hello" });
  });

  it("removes underscore-prefixed keys from array content", () => {
    // 使用 unknown 中转来构造带 _timestamp 的测试数据
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello", _timestamp: 123 }],
      },
    ] as unknown as ChatCompletionMessageParam[];

    const result = normalizeMessages(messages);
    // content 数组中的 _timestamp 字段应该被移除
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "hello" });
    expect(content[0]).not.toHaveProperty("_timestamp");
  });

  it("handles null content without errors", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: null },
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBeNull();
  });
});

/**
 * tool_result 补全测试
 */
describe("normalizeMessages - tool result completion", () => {
  it("inserts placeholder for missing tool result", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      // 缺少 role: "tool", tool_call_id: "call_123" 的消息
      { role: "user", content: "next question" },
    ];

    const result = normalizeMessages(messages);
    // 应该在最后追加一条 tool 消息来补全 call_123
    const toolMsg = result.find(
      (m) =>
        m.role === "tool" &&
        "tool_call_id" in m &&
        (m as unknown as Record<string, unknown>).tool_call_id === "call_123",
    );
    expect(toolMsg).toBeDefined();
    expect((toolMsg as unknown as Record<string, unknown>).content).toBe(
      "(cancelled)",
    );
  });

  it("does not add tool result when it already exists", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_456",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_456",
        content: "file1.txt\nfile2.txt",
      } as unknown as ChatCompletionMessageParam,
    ];

    const result = normalizeMessages(messages);
    // 不应该追加额外的 tool 消息
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
  });
});

/**
 * 连续同角色消息合并测试
 */
describe("normalizeMessages - consecutive role merging", () => {
  it("merges consecutive user messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "first message" },
      { role: "user", content: "second message" },
    ];

    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    // 合并后的 content 应该是数组格式，包含两条消息
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "first message" });
    expect(content[1]).toEqual({ type: "text", text: "second message" });
  });

  it("merges consecutive assistant messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "part 1" },
      { role: "assistant", content: "part 2" },
    ];

    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
  });

  it("does not merge different roles", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];

    const result = normalizeMessages(messages);
    expect(result).toHaveLength(2);
  });

  it("handles empty message list", () => {
    const result = normalizeMessages([]);
    expect(result).toHaveLength(0);
  });

  it("handles single message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "only one" },
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
  });
});
