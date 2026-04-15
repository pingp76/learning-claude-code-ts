/**
 * history.ts — 对话历史管理模块
 *
 * 职责：管理与 LLM 的对话上下文（消息历史）。
 *
 * 为什么需要对话历史？
 * - LLM 是无状态的：每次调用 API 时，需要把之前的对话全部发过去
 * - Agent 循环中会产生多轮对话（用户提问 → 模型回答 → 调用工具 → 工具结果 → 模型再回答）
 * - 所有这些消息都需要按顺序保存，下一次调用 API 时作为上下文传入
 *
 * 设计模式：工厂函数 + 闭包（与 logger.ts 相同的模式）
 * - messages 数组被闭包捕获，外部无法直接修改
 * - 只通过 add/getMessages/clear 三个方法操作，保证数据一致性
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * History — 对话历史管理接口
 *
 * 三个核心操作：
 * - add：添加一条消息（可能是用户消息、模型回复、工具结果等）
 * - getMessages：获取所有消息的副本（用于传给 LLM API）
 * - clear：清空历史（开始新的对话）
 */
export interface History {
  add(message: ChatCompletionMessageParam): void;
  getMessages(): ChatCompletionMessageParam[];
  clear(): void;
}

/**
 * createHistory — 创建对话历史管理器
 *
 * @returns History 接口的实现
 *
 * 内部使用一个数组来存储消息。每次调用 getMessages() 时返回数组的浅拷贝，
 * 这样外部即使修改了返回的数组，也不会影响内部存储。
 */
export function createHistory(): History {
  // 消息数组，按时间顺序存储所有对话消息
  // 每条消息包含 role（角色）和 content（内容）等字段
  const messages: ChatCompletionMessageParam[] = [];

  return {
    // 添加一条消息到历史末尾
    add(message) {
      messages.push(message);
    },

    // 返回消息数组的浅拷贝
    // 为什么返回拷贝？防止调用者意外修改内部数据
    getMessages() {
      return [...messages];
    },

    // 清空所有消息
    // length = 0 是清空数组的高效方式，不会创建新数组
    clear() {
      messages.length = 0;
    },
  };
}
