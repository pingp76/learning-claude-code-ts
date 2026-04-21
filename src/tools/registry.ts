/**
 * registry.ts — 工具注册表
 *
 * 职责：统一管理所有可用工具（注册、查询、获取定义列表）。
 *
 * 为什么需要注册表？
 * - Agent 在调用 LLM 时，需要传入所有工具的定义（让模型知道能调用哪些工具）
 * - Agent 收到模型的 tool_call 后，需要根据工具名找到对应的执行函数
 * - 注册表把"工具定义"和"工具执行"绑定在一起，管理起来更清晰
 *
 * 扩展性设计：
 * - 要添加新工具，只需要调用 register() 注册一个新的 ToolEntry
 * - 不需要修改 agent.ts 或其他模块的代码
 * - 这就是"开放-封闭原则"：对扩展开放，对修改封闭
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { bashToolDefinition, executeBash } from "./bash.js";
import {
  runReadToolDefinition,
  executeRead,
  runWriteToolDefinition,
  executeWrite,
  runEditToolDefinition,
  executeEdit,
} from "./files.js";
import type { ToolResult } from "./types.js";
import type { TodoToolProvider } from "../todo.js";
import type { SubagentToolProvider } from "./subagent.js";

/**
 * ToolExecutor — 工具执行函数的类型
 *
 * 每个工具都需要提供一个执行函数：
 * - 接收一个参数字典（来自 LLM 的 JSON 解析结果）
 * - 返回 Promise<ToolResult>（因为工具执行通常是异步的）
 */
export type ToolExecutor = (args: Record<string, string>) => Promise<ToolResult>;

/**
 * ToolEntry — 工具注册项
 *
 * 把"定义"和"执行"绑定在一起：
 * - definition：告诉 LLM 这个工具的接口（名称、参数、描述）
 * - execute：实际执行工具逻辑的函数
 */
interface ToolEntry {
  definition: ChatCompletionTool;
  execute: ToolExecutor;
}

/**
 * ToolRegistry — 工具注册表的接口
 *
 * 只暴露两个方法：
 * - getToolDefinitions：获取所有工具的定义（用于传给 LLM）
 * - getExecutor：根据工具名获取执行函数（用于处理 tool_call）
 */
export interface ToolRegistry {
  getToolDefinitions(): ChatCompletionTool[];
  getExecutor(name: string): ToolExecutor | undefined;
}

/**
 * createToolRegistry — 创建工具注册表
 *
 * @param todoProvider - 可选的 TodoToolProvider，提供 todo 管理工具
 *
 * 使用 Map 存储已注册的工具，以工具名为 key，ToolEntry 为 value。
 * Map 查找是 O(1) 的，比遍历数组更高效。
 */
export function createToolRegistry(
  todoProvider?: TodoToolProvider,
  subagentProvider?: SubagentToolProvider,
): ToolRegistry {
  // 工具映射表：工具名 → 工具注册项
  const tools = new Map<string, ToolEntry>();

  /**
   * register — 注册一个工具
   *
   * 从工具定义中提取函数名作为 Map 的 key，
   * 将定义和执行函数一起存储。
   */
  function register(entry: ToolEntry): void {
    const name = entry.definition.function?.name;
    if (!name) throw new Error("Tool definition must have a function name");
    tools.set(name, entry);
  }

  // 注册 bash 工具
  // 将 bashToolDefinition（工具描述）和 executeBash（执行函数）绑定在一起
  register({
    definition: bashToolDefinition,
    // 从参数字典中取出 "command" 字段，传给 executeBash
    // ?? "" 是防御性编程：如果 command 字段缺失，使用空字符串
    execute: async (args) => executeBash(args["command"] ?? ""),
  });

  // 注册文件读取工具
  register({
    definition: runReadToolDefinition,
    execute: async (args) => executeRead(args["path"] ?? ""),
  });

  // 注册文件写入工具
  register({
    definition: runWriteToolDefinition,
    execute: async (args) =>
      executeWrite(args["path"] ?? "", args["content"] ?? ""),
  });

  // 注册文件编辑工具
  register({
    definition: runEditToolDefinition,
    execute: async (args) =>
      executeEdit(
        args["path"] ?? "",
        args["old_string"] ?? "",
        args["new_string"] ?? "",
      ),
  });

  // 注册 todo 管理工具（6 个工具）
  // 通过 TodoToolProvider 获取定义和执行函数，与 bash/files 工具完全一致的模式
  if (todoProvider) {
    for (const entry of todoProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册子智能体工具（1 个工具）
  // 通过 SubagentToolProvider 获取定义和执行函数
  // 子智能体本身的注册表中不会传入此 provider，从而防止递归
  if (subagentProvider) {
    for (const entry of subagentProvider.toolEntries) {
      register(entry);
    }
  }

  return {
    // 返回所有工具的定义列表，用于传给 LLM API
    getToolDefinitions() {
      return [...tools.values()].map((t) => t.definition);
    },

    // 根据工具名查找执行函数，找不到返回 undefined
    getExecutor(name) {
      return tools.get(name)?.execute;
    },
  };
}
