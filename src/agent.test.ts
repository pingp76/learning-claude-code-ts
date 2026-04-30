/**
 * agent.test.ts — Agent 与 Hook 集成测试
 *
 * 使用 fake LLM、fake ToolRegistry、fake PermissionManager 测试
 * Agent 主流程中的 Hook 触发行为，不调用真实模型。
 */
import { describe, it, expect, vi } from "vitest";
import { createAgent } from "./agent.js";
import { createHookRunner } from "./hooks.js";
import type { HookHandler } from "./hooks.js";
import { createHistory } from "./history.js";
import { createContextCompressor } from "./compressor.js";
import type { LLMClient, LLMResponse } from "./llm.js";
import type { ToolRegistry, ToolExecutor } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import type { Logger } from "./logger.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

// ============================================================
// Mock 工具
// ============================================================

/** 创建 mock 日志器（所有方法都是 spy） */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * 创建 mock LLM 客户端
 *
 * @param responses - 预设的响应序列，每次调用 chat() 返回下一个
 */
function createMockLLM(responses: LLMResponse[]): LLMClient {
  let callIndex = 0;
  return {
    async chat() {
      const resp = responses[callIndex++];
      if (!resp) throw new Error("No more mock responses");
      return resp;
    },
  };
}

/**
 * 创建 mock 工具注册表
 *
 * @param toolName - 工具名称
 * @param executor - 工具执行函数
 */
function createMockToolRegistry(
  toolName: string,
  executor: ToolExecutor,
): ToolRegistry {
  const definition: ChatCompletionTool = {
    type: "function",
    function: {
      name: toolName,
      description: `Mock ${toolName}`,
      parameters: { type: "object", properties: {} },
    },
  };
  return {
    getToolDefinitions: () => [definition],
    getExecutor: (name: string) => (name === toolName ? executor : undefined),
  };
}

/** 创建 mock PermissionManager（auto 模式，全部放行） */
function createMockPermissionManager() {
  return {
    check: () => ({ action: "allow" as const }),
    setMode: vi.fn(),
    getMode: () => "auto" as const,
    getProjectDir: () => "/tmp",
  };
}

/** 构造一个 tool_call 对象 */
function makeToolCall(
  id: string,
  name: string,
  args: string = "{}",
): { id: string; type: "function"; function: { name: string; arguments: string } } {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: args },
  };
}

// ============================================================
// Agent 集成测试
// ============================================================

describe("Agent Hook 集成", () => {
  /** 创建测试用 Agent 的辅助函数 */
  function createTestAgent(deps: {
    llmResponses: LLMResponse[];
    toolName?: string;
    toolExecutor?: ToolExecutor;
    hookHandlers?: Partial<Record<string, HookHandler[]>>;
  }) {
    const logger = createMockLogger();
    const toolName = deps.toolName ?? "run_bash";
    const toolExecutor =
      deps.toolExecutor ??
      (async () => ({ output: "tool output", error: false }) as ToolResult);

    const history = createHistory();
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      maxContextTokens: 80000,
      compactKeepRecent: 4,
    });
    const permissionManager = createMockPermissionManager();
    const hookRunner = createHookRunner(
      deps.hookHandlers ?? {},
      logger,
    );

    const agent = createAgent({
      llm: createMockLLM(deps.llmResponses),
      history,
      tools: createMockToolRegistry(toolName, toolExecutor),
      logger,
      compressor,
      permissionManager,
      hookRunner,
    });

    return { agent, history, logger };
  }

  // -----------------------------------------------------------------
  // SessionStart
  // -----------------------------------------------------------------

  it("SessionStart exitCode 2 时，在首次 LLM 调用前注入补充消息", async () => {
    const logger = createMockLogger();
    const history = createHistory();
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      maxContextTokens: 80000,
      compactKeepRecent: 4,
    });
    const hookRunner = createHookRunner(
      {
        SessionStart: [
          () => ({
            exitCode: 2 as const,
            message: "工作目录提示",
          }),
        ],
      },
      logger,
    );

    const agent = createAgent({
      llm: createMockLLM([{ content: "done", toolCalls: [] }]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger,
      compressor,
      permissionManager: createMockPermissionManager(),
      hookRunner,
    });

    await agent.run("hello");

    // history 中应有 Hook 注入的补充消息
    // 注意：prepareMessages 管道会合并连续 user 消息，所以检查 history 而非 LLM 输入
    const entries = history.getEntries();
    const hookEntries = entries.filter(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes("[Hook: SessionStart]"),
    );
    expect(hookEntries.length).toBeGreaterThanOrEqual(1);
    // 验证 Hook 消息的内容包含 handler 返回的文本
    const hookContent = (hookEntries[0]!.message as { content: string }).content;
    expect(hookContent).toContain("工作目录提示");
  });

  it("SessionStart 每个 Agent 实例只触发一次", async () => {
    const sessionHandler = vi.fn<HookHandler>().mockReturnValue({ exitCode: 0 });

    const { agent } = createTestAgent({
      llmResponses: [
        // 第一次 run
        { content: "first response", toolCalls: [] },
        // 第二次 run
        { content: "second response", toolCalls: [] },
      ],
      hookHandlers: { SessionStart: [sessionHandler] },
    });

    await agent.run("first query");
    await agent.run("second query");

    // SessionStart handler 只应被调用一次（第一次 run）
    expect(sessionHandler).toHaveBeenCalledTimes(1);
  });

  it("SessionStart exitCode 1 时，history 不写入用户消息", async () => {
    const { agent, history } = createTestAgent({
      llmResponses: [
        // 第二次 run（如果 SessionStart 没被正确处理，可能需要这个响应）
        { content: "second response", toolCalls: [] },
      ],
      hookHandlers: {
        SessionStart: [
          () => ({
            exitCode: 1 as const,
            message: "禁止启动",
          }),
        ],
      },
    });

    // 第一次 run 被 SessionStart block
    const result = await agent.run("blocked query");
    expect(result).toBe("禁止启动");

    // history 中不应有任何消息（block 在 appendMessage 之前）
    expect(history.getEntries()).toHaveLength(0);

    // 第二次 run 应该正常工作（SessionStart 不再触发，history 干净）
    const result2 = await agent.run("second query");
    expect(result2).toBe("second response");

    // history 中只有第二次 run 的消息
    const entries = history.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // 不应包含被阻止的 query
    const blockedQuery = entries.find(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes("blocked query"),
    );
    expect(blockedQuery).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // PreToolUse
  // -----------------------------------------------------------------

  it("PreToolUse exitCode 1 时，不执行工具，写入 blocked tool_result", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "should not reach",
      error: false,
    });

    const { agent, history } = createTestAgent({
      llmResponses: [
        // 第一轮：LLM 发起工具调用
        {
          content: null,
          toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
        },
        // 第二轮：LLM 看到 blocked 结果后回复
        { content: "understood", toolCalls: [] },
      ],
      toolExecutor,
      hookHandlers: {
        PreToolUse: [
          () => ({
            exitCode: 1 as const,
            message: "禁止执行",
          }),
        ],
      },
    });

    const result = await agent.run("run ls");

    // 工具执行函数不应被调用
    expect(toolExecutor).not.toHaveBeenCalled();

    // 历史中应有 blocked tool_result
    const entries = history.getEntries();
    const blockedEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "tool" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes("Blocked by PreToolUse hook"),
    );
    expect(blockedEntry).toBeDefined();

    // 最终回复是 LLM 看到 blocked 后的回复
    expect(result).toBe("understood");
  });

  it("PreToolUse exitCode 2 时，工具照常执行，所有 tool_result 后追加 user 补充消息", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "file list",
      error: false,
    });

    const { agent, history } = createTestAgent({
      llmResponses: [
        {
          content: null,
          toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
        },
        { content: "final answer", toolCalls: [] },
      ],
      toolExecutor,
      hookHandlers: {
        PreToolUse: [
          () => ({
            exitCode: 2 as const,
            message: "即将执行 bash",
          }),
        ],
      },
    });

    await agent.run("run ls");

    // 工具应该被执行
    expect(toolExecutor).toHaveBeenCalledTimes(1);

    // 历史中应有 Hook 注入的 user 消息
    const entries = history.getEntries();
    const userEntries = entries.filter(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes("[Hook: PreToolUse]"),
    );
    expect(userEntries.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------
  // PostToolUse
  // -----------------------------------------------------------------

  it("PostToolUse exitCode 2 时，追加 user 补充消息", async () => {
    const { agent, history } = createTestAgent({
      llmResponses: [
        {
          content: null,
          toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
        },
        { content: "noted", toolCalls: [] },
      ],
      hookHandlers: {
        PostToolUse: [
          () => ({
            exitCode: 2 as const,
            message: "工具执行完毕提醒",
          }),
        ],
      },
    });

    await agent.run("run ls");

    const entries = history.getEntries();
    const userEntries = entries.filter(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes("[Hook: PostToolUse]"),
    );
    expect(userEntries.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------
  // 多 tool call 场景
  // -----------------------------------------------------------------

  it("多 tool call 时，补充消息不插入到 tool_result 中间", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "result",
      error: false,
    });

    const { agent, history } = createTestAgent({
      llmResponses: [
        {
          content: null,
          toolCalls: [
            makeToolCall("call_1", "run_bash", '{"command":"ls"}'),
            makeToolCall("call_2", "run_bash", '{"command":"pwd"}'),
          ],
        },
        { content: "done", toolCalls: [] },
      ],
      toolExecutor,
      hookHandlers: {
        PreToolUse: [
          () => ({
            exitCode: 2 as const,
            message: "提醒",
          }),
        ],
      },
    });

    await agent.run("run both");

    // 验证历史中消息顺序：
    // assistant(tool_calls) → tool(result1) → tool(result2) → user(hook messages)
    // 中间不应有 user 消息
    const entries = history.getEntries();
    const roles = entries.map(
      (e) => (e.message as { role: string }).role,
    );

    // 找到第一个 tool 消息的索引
    const firstToolIdx = roles.indexOf("tool");
    const lastToolIdx = roles.lastIndexOf("tool");

    // 在 tool 消息之间不应有 user 消息
    const betweenTools = roles.slice(firstToolIdx, lastToolIdx + 1);
    expect(betweenTools.every((r) => r === "tool")).toBe(true);

    // 两个工具都应该被执行
    expect(toolExecutor).toHaveBeenCalledTimes(2);
  });
});
