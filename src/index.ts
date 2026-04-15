/**
 * index.ts — 程序入口
 *
 * 职责：初始化所有组件，启动 REPL（Read-Eval-Print Loop）交互循环。
 *
 * REPL 的工作方式：
 * 1. Read：读取用户输入
 * 2. Eval：将输入交给 Agent 处理
 * 3. Print：打印 Agent 的回复
 * 4. Loop：回到步骤 1，等待下一次输入
 *
 * 这就是命令行聊天程序的经典模式。
 *
 * 组件初始化顺序：
 * config → logger → llm client → history → tools → agent
 * 每个组件都只依赖前面已经创建的组件，没有循环依赖。
 */

import * as readline from "node:readline";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createLLMClient } from "./llm.js";
import { createHistory } from "./history.js";
import { createToolRegistry } from "./tools/registry.js";
import { createAgent } from "./agent.js";

/**
 * main — 主函数
 *
 * 将所有逻辑包在 async 函数中，方便使用 await。
 * Node.js 的顶层 await 只能在 ESM 模块中使用，
 * 这里使用 async main() 是更通用的做法。
 */
async function main() {
  // 1. 加载配置（从 .env 文件）
  const config = loadConfig();

  // 2. 创建日志器
  const logger = createLogger(config.logLevel);

  // 3. 创建 LLM 客户端（使用 MiniMax 的 API）
  const llm = createLLMClient(config);

  // 4. 创建对话历史管理器
  const history = createHistory();

  // 5. 创建工具注册表（自动注册 bash 工具）
  const tools = createToolRegistry();

  // 6. 创建 Agent（将上面所有组件注入）
  const agent = createAgent({ llm, history, tools, logger });

  logger.info("Agent started (model: %s)", config.model);
  console.log("Coding Agent REPL — type your query, or 'exit' to quit.\n");

  // 创建 readline 接口，用于从终端读取用户输入
  const rl = readline.createInterface({
    input: process.stdin,  // 标准输入（键盘）
    output: process.stdout, // 标准输出（屏幕）
  });

  /**
   * prompt — 交互提示函数
   *
   * 这是一个递归函数：每次用户输入后，处理完毕会再次调用自身。
   * 这不是传统的递归（不会栈溢出），因为 rl.question 是异步的，
   * 每次调用都会注册一个回调，然后返回，不会阻塞。
   */
  const prompt = (): void => {
    rl.question("You > ", async (input) => {
      const trimmed = input.trim();

      // 输入校验：空内容直接跳过，重新提示
      if (!trimmed) {
        prompt();
        return;
      }

      // 输入 "exit" 时退出程序
      if (trimmed.toLowerCase() === "exit") {
        logger.info("User exited");
        console.log("Goodbye!");
        rl.close();
        return;
      }

      try {
        // 调用 Agent 处理用户输入，等待最终回复
        const response = await agent.run(trimmed);
        console.log(`\nAgent > ${response}\n`);
      } catch (err) {
        // 捕获 Agent 运行中的错误（如 API 调用失败），打印错误但不退出
        logger.error("Agent error: %s", err);
        console.error(
          `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      // 继续等待下一次输入
      prompt();
    });
  };

  // 启动第一次提示
  prompt();
}

// 捕获 main 函数中未被处理的异常（如配置缺失）
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
