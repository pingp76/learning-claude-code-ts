/**
 * repl.ts — REPL（Read-Eval-Print Loop）交互层
 *
 * 职责：处理终端交互循环，将用户输入分发给 Agent 或 CLI 命令系统。
 *
 * 为什么从 index.ts 中拆出来？
 * - index.ts 应该只做"组件初始化和接线"（组装根）
 * - REPL 循环、命令分发、错误显示属于"交互层"
 * - 分离后，未来可以替换为 Web UI 或其他交互方式，不影响组装逻辑
 *
 * REPL 的工作方式：
 * 1. Read：通过 Terminal 读取用户输入
 * 2. Eval：判断是 CLI 命令还是 Agent 查询，分别处理
 * 3. Print：打印处理结果
 * 4. Loop：回到步骤 1
 */

import type { Agent } from "./agent.js";
import type { Logger } from "./logger.js";
import type { CliCommandRegistry } from "./cli-commands.js";
import type { Terminal } from "./terminal.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * ReplDeps — REPL 的依赖项
 *
 * 通过依赖注入传入，便于测试和替换。
 */
export interface ReplDeps {
  /** Agent 实例，处理用户查询 */
  agent: Agent;
  /** 日志器 */
  logger: Logger;
  /** CLI 命令注册表（可选） */
  commands?: CliCommandRegistry;
  /** 终端接口（共享 readline，供 REPL 和权限确认使用） */
  terminal: Terminal;
}

/**
 * Repl — REPL 实例接口
 */
export interface Repl {
  /** 启动 REPL 循环 */
  start(): void;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createRepl — 创建 REPL 实例
 *
 * @param deps - REPL 的依赖项
 * @returns Repl 接口的实现
 */
export function createRepl(deps: ReplDeps): Repl {
  const { agent, logger, commands, terminal } = deps;

  return {
    start() {
      console.log("Coding Agent REPL — type your query, or 'exit' to quit.\n");

      /**
       * prompt — 交互提示函数
       *
       * 递归调用模式：每次用户输入处理完后再次调用自身。
       * 因为 terminal.question 是异步的，不会栈溢出。
       */
      const prompt = async (): Promise<void> => {
        const input = await terminal.question("You > ");
        const trimmed = input.trim();

        // 空输入跳过
        if (!trimmed) {
          prompt();
          return;
        }

        // "exit" 退出
        if (trimmed.toLowerCase() === "exit") {
          logger.info("User exited");
          console.log("Goodbye!");
          terminal.close();
          return;
        }

        // 尝试分发给 CLI 命令
        if (commands && commands.dispatch(trimmed)) {
          prompt();
          return;
        }

        // 交给 Agent 处理
        try {
          const response = await agent.run(trimmed);
          console.log(`\nAgent > ${response}\n`);
        } catch (err) {
          logger.error("Agent error: %s", err);
          console.error(
            `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }

        prompt();
      };

      prompt();
    },
  };
}
