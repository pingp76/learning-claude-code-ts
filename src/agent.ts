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
 *
 * 消息处理管道：
 * history.getMessages() → annotateWithRounds() → normalizeMessages()
 *   → groupToBlocks() → decayOldBlocks() → [compactHistory()]
 *   → flattenToMessages() → llm.chat()
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Logger } from "./logger.js";
import type { LLMClient } from "./llm.js";
import type { History } from "./history.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { TodoManager } from "./todo.js";
import type { ContextCompressor } from "./compressor.js";
import { normalizeMessages } from "./normalize.js";
import {
  groupToBlocks,
  flattenToMessages,
  estimateMessagesTokens,
} from "./message-block.js";

/**
 * Agent — Agent 的接口
 *
 * 目前只有一个方法 run()：接收用户输入，返回 Agent 的最终回复。
 * 父智能体和子智能体都实现这个接口，区别在于依赖注入的参数不同。
 */
export interface Agent {
  run(query: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

/**
 * createAgent — 创建 Agent 实例
 *
 * @param deps - Agent 的依赖项（通过依赖注入传入，便于测试和替换）
 *   - llm:         LLM 客户端，用于调用大模型
 *   - history:     对话历史管理器，用于维护上下文
 *   - tools:       工具注册表，用于查找和执行工具
 *   - logger:      日志器，用于输出调试信息
 *   - todoManager: 可选，TODO 管理器（子智能体不需要）
 *   - maxRounds:   可选，最大循环轮数（子智能体需要此限制，防止无限循环）
 *   - compressor:  上下文压缩器，用于管理上下文长度
 *   - maxContextTokens: 可选，触发全量压缩的 token 阈值（子智能体可独立配置）
 */
export function createAgent(deps: {
  llm: LLMClient;
  history: History;
  tools: ToolRegistry;
  logger: Logger;
  todoManager?: TodoManager;
  maxRounds?: number;
  compressor: ContextCompressor;
  maxContextTokens?: number;
}): Agent {
  const {
    llm,
    history,
    tools,
    logger,
    todoManager,
    maxRounds,
    compressor,
    maxContextTokens = 80000,
  } = deps;

  // ---- 轮次追踪 ----
  // messageRounds 与 history 内部的 messages 数组平行
  // 每次 history.add() 后同步 push(roundCount)
  // 用于 annotateWithRounds() 给消息标注轮次信息
  const messageRounds: number[] = [];

  /**
   * annotateWithRounds — 给消息列表标注 _round 元数据
   *
   * history.getMessages() 返回的消息格式：
   * [system_prompt(可选), user, assistant, tool, ...]
   * system prompt 由 history 独立管理，不在 messageRounds 中。
   * 所以 user/assistant/tool 消息的索引需要偏移 1（如果有 system prompt）。
   */
  function annotateWithRounds(
    msgs: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const hasSP = msgs.length > 0 && msgs[0]!.role === "system";
    const offset = hasSP ? 1 : 0;
    return msgs.map((msg, i) => {
      if (i < offset) return msg; // system prompt 不标注
      const round = messageRounds[i - offset];
      if (round === undefined) return msg;
      // 通过 unknown 中转，给消息添加 _round 元数据
      return { ...msg, _round: round } as unknown as ChatCompletionMessageParam;
    });
  }

  /**
   * addWithRound — 向 history 添加消息并同步记录轮次
   *
   * 封装 history.add() + messageRounds.push() 的原子操作，
   * 确保两者始终同步。
   */
  function addWithRound(
    message: ChatCompletionMessageParam,
    round: number,
  ): void {
    history.add(message);
    messageRounds.push(round);
  }

  return {
    /**
     * run — 执行一次 Agent 循环
     *
     * @param query - 用户输入的查询文本
     * @returns Agent 的最终文字回复
     */
    async run(query) {
      logger.info("User query: %s", query);

      // 将用户消息加入对话历史（轮次为 0，即用户输入轮次）
      addWithRound({ role: "user", content: query }, 0);

      // Agent 主循环：不断调用 LLM，直到它不再请求工具调用
      let roundCount = 0;

      for (;;) {
        roundCount++;

        // 子智能体轮数上限检测
        if (maxRounds !== undefined && roundCount > maxRounds) {
          logger.info("Reached max rounds limit (%d)", maxRounds);
          const lastAssistantMsg = [...history.getMessages()]
            .reverse()
            .find(
              (m) =>
                m.role === "assistant" &&
                typeof m.content === "string" &&
                m.content,
            );
          const summary =
            lastAssistantMsg && typeof lastAssistantMsg.content === "string"
              ? lastAssistantMsg.content
              : "Task incomplete: reached maximum rounds before generating a final response.";
          return `[Round limit reached (${maxRounds})] ${summary}`;
        }

        // 父智能体的 TODO 轮次检测（子智能体没有 todoManager，跳过）
        if (todoManager) {
          const interruptMsg = todoManager.tickRound();
          if (interruptMsg) {
            addWithRound({ role: "user", content: interruptMsg }, roundCount);
          }
        }

        const toolDefs = tools.getToolDefinitions();
        logger.debug(
          "Calling LLM with %d messages, %d tools",
          history.getMessages().length,
          toolDefs.length,
        );

        // ============================================================
        // 消息处理管道：annotate → normalize → group → compress → flatten
        // 如果压缩过程中出错，降级使用标准化后的消息
        // ============================================================
        const raw = history.getMessages();
        const annotated = annotateWithRounds(raw);
        const normalized = normalizeMessages(annotated);
        let finalMsgs: ChatCompletionMessageParam[];

        try {
          const blocks = groupToBlocks(normalized);

          // P0 衰减压缩：缩短旧的工具结果
          const decayed = compressor.decayOldBlocks(blocks, roundCount);

          // P2 全量压缩：上下文超过阈值时触发
          let finalBlocks = decayed;
          const tokenEstimate = estimateMessagesTokens(normalized);
          if (tokenEstimate > maxContextTokens) {
            logger.info(
              "Context over threshold (%d > %d), compacting...",
              tokenEstimate,
              maxContextTokens,
            );
            const compacted = compressor.compactHistory(decayed);
            finalBlocks = compacted.blocks;
          }

          // 还原为扁平消息列表（清除 _round 元数据）
          finalMsgs = flattenToMessages(finalBlocks);
        } catch (compressErr) {
          // 压缩管道任何环节出错，降级使用标准化后的消息
          logger.warn(
            "Compression pipeline failed, using normalized messages: %s",
            compressErr instanceof Error ? compressErr.message : String(compressErr),
          );
          finalMsgs = normalized;
        }

        // 调用 LLM
        const response = await llm.chat(finalMsgs, toolDefs);
        logger.debug(
          "LLM response: content=%s, toolCalls=%d",
          response.content ? "yes" : "none",
          response.toolCalls.length,
        );

        // 将模型的回复加入历史
        addWithRound(
          {
            role: "assistant",
            content: response.content ?? null,
            tool_calls:
              response.toolCalls.length > 0 ? response.toolCalls : undefined,
          } as ChatCompletionMessageParam,
          roundCount,
        );

        // 处理工具调用
        if (response.toolCalls.length > 0) {
          for (const toolCall of response.toolCalls) {
            const fnName = toolCall.function.name;
            const executor = tools.getExecutor(fnName);

            if (!executor) {
              logger.warn("Unknown tool: %s", fnName);
              addWithRound(
                {
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Error: Unknown tool "${fnName}"`,
                } as ChatCompletionMessageParam,
                roundCount,
              );
              continue;
            }

            logger.info("Tool call: %s(%s)", fnName, toolCall.function.arguments);

            // 解析工具参数
            let args: Record<string, string>;
            try {
              args = JSON.parse(toolCall.function.arguments) as Record<
                string,
                string
              >;
            } catch (parseError) {
              logger.warn(
                "Failed to parse tool args: %s",
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
              );
              addWithRound(
                {
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Error: Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
                } as ChatCompletionMessageParam,
                roundCount,
              );
              continue;
            }

            // 执行工具
            const result = await executor(args);

            // P1 即时压缩：对 run_bash 的大输出进行压缩
            let toolOutput = result.output;
            if (fnName === "run_bash") {
              const compressed = compressor.compressToolResult(
                toolCall.id,
                result.output,
              );
              toolOutput = compressed.content;
            }

            logger.info(
              "Tool result (%s): %s",
              result.error ? "error" : "ok",
              toolOutput.slice(0, 200),
            );

            // 将工具执行结果加入历史
            addWithRound(
              {
                role: "tool",
                tool_call_id: toolCall.id,
                content: toolOutput,
              } as ChatCompletionMessageParam,
              roundCount,
            );
          }
          // 继续循环
          continue;
        }

        // 没有工具调用 → 最终回复
        if (response.content) {
          return response.content;
        }
        return "(no response)";
      }
    },
  };
}
