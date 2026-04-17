/**
 * agent.ts — Agent 主循环模块
 *
 * 职责：实现 Coding Agent 的核心循环 —— think → act → observe。
 *
 * Agent 循环的工作原理（这是所有 AI Agent 的核心模式）：
 *
 *   ┌─────────────────────────────────────────┐
 *   │  1. THINK: 将对话历史发给 LLM            │
 *   │  2. ACT:  LLM 返回文本回复 或 工具调用    │
 *   │  3. OBSERVE:                            │
 *   │     - 如果是工具调用 → 执行工具，将结果   │
 *   │       加入历史，回到步骤 1               │
 *   │     - 如果是文本回复 → 返回给用户        │
 *   └─────────────────────────────────────────┘
 *
 * 这个循环会一直运行，直到 LLM 不再请求工具调用为止。
 * 也就是说，一个用户问题可能触发多轮 LLM 调用：
 * - 第 1 轮：LLM 决定调用 bash 工具查看文件
 * - 第 2 轮：LLM 看到文件内容，决定再调用 bash 工具运行代码
 * - 第 3 轮：LLM 看到运行结果，生成最终的文字回复给用户
 */

import type { Logger } from "./logger.js";
import type { LLMClient } from "./llm.js";
import type { History } from "./history.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { TodoManager } from "./todo.js";

/**
 * Agent — Agent 的接口
 *
 * 目前只有一个方法 run()：接收用户输入，返回 Agent 的最终回复。
 */
export interface Agent {
  run(query: string): Promise<string>;
}

/**
 * createAgent — 创建 Agent 实例
 *
 * @param deps - Agent 的依赖项（通过依赖注入传入，便于测试和替换）
 *   - llm:     LLM 客户端，用于调用大模型
 *   - history: 对话历史管理器，用于维护上下文
 *   - tools:   工具注册表，用于查找和执行工具
 *   - logger:  日志器，用于输出调试信息
 *
 * @returns Agent 接口的实现
 */
export function createAgent(deps: {
  llm: LLMClient;
  history: History;
  tools: ToolRegistry;
  logger: Logger;
  todoManager: TodoManager;
}): Agent {
  const { llm, history, tools, logger, todoManager } = deps;

  return {
    /**
     * run — 执行一次 Agent 循环
     *
     * @param query - 用户输入的查询文本
     * @returns Agent 的最终文字回复
     *
     * 完整流程：
     * 1. 将用户消息加入历史
     * 2. 调用 LLM（传入完整历史 + 工具定义）
     * 3. 将 LLM 的回复加入历史
     * 4. 如果 LLM 请求了工具调用：
     *    a. 逐个执行工具
     *    b. 将工具结果加入历史
     *    c. 回到步骤 2（让 LLM 根据工具结果继续思考）
     * 5. 如果 LLM 没有请求工具调用，返回文本回复
     */
    async run(query) {
      logger.info("User query: %s", query);

      // 将用户消息加入对话历史
      history.add({ role: "user", content: query });

      // Agent 主循环：不断调用 LLM，直到它不再请求工具调用
      for (;;) {
        // 轮次上限检测：每次迭代前检查当前 task 的轮次
        // 如果达到上限，自动中断并返回提示信息给 LLM
        const interruptMsg = todoManager.tickRound();
        if (interruptMsg) {
          // 将中断提示注入对话历史，让 LLM 在下一轮看到并自行决定如何处理
          history.add({ role: "user", content: interruptMsg });
        }

        const toolDefs = tools.getToolDefinitions();
        logger.debug(
          "Calling LLM with %d messages, %d tools",
          history.getMessages().length,
          toolDefs.length,
        );

        // 调用 LLM，传入对话历史和可用工具定义
        const response = await llm.chat(history.getMessages(), toolDefs);
        logger.debug(
          "LLM response: content=%s, toolCalls=%d",
          response.content ? "yes" : "none",
          response.toolCalls.length,
        );

        // 将模型的回复加入历史（即使是工具调用，也需要保存完整的 assistant 消息）
        // 这样 LLM 在下一轮调用时能看到自己之前说了什么
        history.add({
          role: "assistant",
          content: response.content ?? null,
          tool_calls:
            response.toolCalls.length > 0 ? response.toolCalls : undefined,
        } as import("openai/resources/chat/completions").ChatCompletionMessageParam);

        // 处理工具调用
        if (response.toolCalls.length > 0) {
          for (const toolCall of response.toolCalls) {
            const fnName = toolCall.function.name;

            // 根据工具名查找执行函数
            const executor = tools.getExecutor(fnName);

            if (!executor) {
              // 工具不存在，返回错误信息（不是抛异常，而是作为工具结果告诉 LLM）
              logger.warn("Unknown tool: %s", fnName);
              history.add({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Error: Unknown tool "${fnName}"`,
              });
              continue;
            }

            logger.info("Tool call: %s(%s)", fnName, toolCall.function.arguments);

            // 解析工具参数（LLM 返回的是 JSON 字符串，需要解析为对象）
            // 用 try-catch 包裹，防止 LLM 返回格式错误的 JSON 导致整个循环崩溃
            let args: Record<string, string>;
            try {
              args = JSON.parse(toolCall.function.arguments) as Record<
                string,
                string
              >;
            } catch (parseError) {
              // JSON 解析失败，将错误信息作为工具结果告知 LLM，让它自行修正
              logger.warn(
                "Failed to parse tool args: %s",
                parseError instanceof Error ? parseError.message : String(parseError),
              );
              history.add({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Error: Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
              });
              continue;
            }

            // 执行工具
            const result = await executor(args);

            logger.info(
              "Tool result (%s): %s",
              result.error ? "error" : "ok",
              result.output.slice(0, 200),
            );

            // 将工具执行结果加入历史（role="tool"，tool_call_id 关联到对应的工具调用）
            history.add({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result.output,
            });
          }
          // 继续循环：让 LLM 看到工具结果后继续思考
          continue;
        }

        // 没有工具调用 → 这是最终回复，返回给用户
        if (response.content) {
          return response.content;
        }
        return "(no response)";
      }
    },
  };
}
