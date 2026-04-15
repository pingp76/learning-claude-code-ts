/**
 * normalize.ts — 消息标准化模块
 *
 * 职责：在将消息发送给 LLM API 之前，对消息列表进行标准化处理。
 *
 * 为什么需要标准化？
 * - Agent 循环中可能产生不符合 API 要求的消息格式
 * - 某些消息可能包含内部元数据（以 "_" 开头的字段），API 无法识别
 * - 工具调用可能缺少对应的结果消息，导致 API 报错
 * - 连续同角色消息不符合 OpenAI API 的严格交替要求
 *
 * 标准化做三件事：
 * 1. 过滤元数据字段（以 "_" 开头的键）
 * 2. 补全缺失的 tool_result（每个 tool_call 必须有对应的 tool 消息）
 * 3. 合并连续同角色消息（user+user → user，assistant+assistant → assistant）
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * normalizeMessages — 消息标准化主函数
 *
 * @param messages - 原始消息列表（可能包含不规范的格式）
 * @returns 标准化后的消息列表（符合 OpenAI API 要求）
 */
export function normalizeMessages(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // 步骤 1：过滤元数据字段
  const cleaned = cleanMetadata(messages);

  // 步骤 2：补全缺失的 tool_result
  const withToolResults = ensureToolResults(cleaned);

  // 步骤 3：合并连续同角色消息
  const merged = mergeConsecutiveRoles(withToolResults);

  return merged;
}

/**
 * cleanMetadata — 过滤消息中的元数据字段
 *
 * 处理规则：
 * - content 是字符串 → 直接保留（最常见的格式）
 * - content 是数组 → 过滤每个 block 中以 "_" 开头的键（如 _timestamp、_id）
 * - content 是 null/undefined → 保留不变
 *
 * 元数据字段（如 _timestamp）是内部系统使用的，LLM API 无法识别，
 * 发送过去可能导致 API 报错或行为异常。
 */
function cleanMetadata(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    // 如果 content 不是数组，直接返回原消息（不需要处理）
    if (typeof msg.content !== "object" || msg.content === null) {
      return msg;
    }

    // content 是数组格式（OpenAI 多模态消息格式）
    // 过滤每个 block 中以下划线开头的键
    if (Array.isArray(msg.content)) {
      const cleanedContent = msg.content
        .filter(
          (block) => typeof block === "object" && block !== null,
        )
        .map((block) =>
          // 移除所有以 "_" 开头的键
          // 使用 unknown 中转避免 TS 严格类型检查报错
          Object.fromEntries(
            Object.entries(block as unknown as Record<string, unknown>).filter(
              ([key]) => !key.startsWith("_"),
            ),
          ),
        );

      return {
        ...msg,
        content: cleanedContent,
      } as unknown as ChatCompletionMessageParam;
    }

    return msg;
  });
}

/**
 * ensureToolResults — 确保每个 tool_call 都有对应的 tool 消息
 *
 * OpenAI API 的要求：
 * - assistant 消息中的每个 tool_call（通过 tool_call_id 标识）
 *   都必须有且仅有一条 role="tool" 的消息作为回应
 * - 如果缺少 tool 消息，API 会报错
 *
 * 这个函数会：
 * 1. 收集所有已有的 tool 消息的 tool_call_id
 * 2. 遍历所有 assistant 消息的 tool_calls
 * 3. 如果某个 tool_call 没有对应的 tool 消息，插入一条占位消息
 */
function ensureToolResults(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const result = [...messages];

  // 收集所有已有的 tool 消息的 tool_call_id
  const existingToolIds = new Set<string>();
  for (const msg of result) {
    if (msg.role === "tool" && "tool_call_id" in msg) {
      existingToolIds.add(msg.tool_call_id as string);
    }
  }

  // 遍历 assistant 消息，检查 tool_calls 是否都有对应的 tool 消息
  for (const msg of result) {
    if (msg.role !== "assistant") continue;
    if (!("tool_calls" in msg) || !Array.isArray(msg.tool_calls)) continue;

    for (const toolCall of msg.tool_calls) {
      // 如果这个 tool_call 没有对应的 tool 消息，插入占位消息
      if (toolCall.id && !existingToolIds.has(toolCall.id)) {
        result.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "(cancelled)",
        } as ChatCompletionMessageParam);
      }
    }
  }

  return result;
}

/**
 * mergeConsecutiveRoles — 合并连续同角色消息
 *
 * OpenAI API 要求消息角色严格交替（user → assistant → tool → assistant → ...）。
 * 如果出现连续两条同角色消息（如 user + user），API 会报错。
 *
 * 合并策略：
 * - 只合并 user 和 assistant 角色（tool 角色有 tool_call_id，不能合并）
 * - 两条都是 string content → 拼接字符串
 * - 任一条是数组 content → 统一转为数组格式后拼接
 * - 不同角色 → 直接追加为新消息
 */
function mergeConsecutiveRoles(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return [];

  const merged: ChatCompletionMessageParam[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]!;
    const last = merged[merged.length - 1]!;

    // 只合并 user 和 assistant 的连续消息
    // tool 消息有 tool_call_id 字段，不能简单合并
    if (
      msg.role === last.role &&
      (msg.role === "user" || msg.role === "assistant")
    ) {
      // 将两条消息的 content 都转为数组格式后拼接
      const prevContent = toArrayContent(last.content);
      const currContent = toArrayContent(msg.content);

      // 更新最后一条消息的 content（使用 unknown 中转避免类型不兼容）
      ;(last as unknown as { content: unknown }).content = prevContent.concat(
        currContent,
      );
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

/**
 * toArrayContent — 将消息 content 统一转为数组格式
 *
 * OpenAI 消息的 content 有两种格式：
 * - 字符串：普通文本，如 "hello"
 * - 数组：多部分内容（文本 + 图片等），如 [{type: "text", text: "hello"}]
 *
 * 为了合并消息，需要统一为数组格式再拼接。
 *
 * @param content - 原始 content（string、数组、或 null）
 * @returns 数组格式的 content
 */
function toArrayContent(
  content: string | unknown[] | null | undefined,
): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    return content as Array<Record<string, unknown>>;
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  // null 或 undefined → 空数组
  return [];
}
