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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createLLMClient } from "./llm.js";
import { createHistory } from "./history.js";
import { createToolRegistry } from "./tools/registry.js";
import { createAgent } from "./agent.js";
import { createTodoManager } from "./todo.js";
import { createSubagentToolProvider } from "./tools/subagent.js";
import {
  createSkillManager,
  createSkillToolProvider,
  SKILL_SYSTEM_PROMPT_HINT,
} from "./skills.js";
import { createLLMLogger } from "./llm-logger.js";
import { createContextCompressor } from "./compressor.js";

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
  //    同时创建 LLM 通信日志记录器，将原始请求/响应写入 logs/ 目录
  const llmLogger = createLLMLogger();
  const llm = createLLMClient(config, llmLogger);

  // 4. 创建对话历史管理器
  const history = createHistory();

  // 5. 创建 todo 管理器（session 级别的任务列表）
  const todoManager = createTodoManager();

  // 6. 创建 Skill 管理器（扫描 skills/ 目录）
  //    如果 skills/ 目录存在，解析所有 SKILL.md 的 frontmatter
  //    如果不存在，skill 功能禁用，不影响其他功能
  const skillsDir = resolve(process.cwd(), "skills");
  const skillManager = createSkillManager(skillsDir);
  if (existsSync(skillsDir)) {
    skillManager.scan();
    logger.info("Loaded %d skills", skillManager.listMeta().length);
  } else {
    logger.info("No skills/ directory found, skills disabled");
  }

  // 7. 创建 skill 工具提供者
  //    必须在 subagentProvider 之前创建，因为子智能体也需要 skill 工具
  const skillProvider = createSkillToolProvider(skillManager);

  // 8. 创建子智能体工具提供者
  //    注入 createAgent 和过滤注册表工厂，打破循环依赖
  //    createFilteredRegistry 传入 skillProvider → 子智能体拥有 bash + files + skill
  //    不传 subagentProvider（防递归）和 todoProvider（隔离上下文中用户看不到进度）
  //    createCompressorFn 为子智能体创建独立的压缩器实例
  const subagentProvider = createSubagentToolProvider({
    llm,
    logger,
    createFilteredRegistry: () => createToolRegistry(undefined, undefined, skillProvider),
    createAgentFn: createAgent,
    createCompressorFn: () => createContextCompressor(config.compression),
  });

  // 9. 创建工具注册表（自动注册 bash、files、todo、subagent、skill 工具）
  const tools = createToolRegistry(todoManager, subagentProvider, skillProvider);

  // 10. 设置 system prompt（双保险策略 2：帮助 LLM 理解 skill）
  //     只有当存在可用 skill 时才注入，避免无谓的上下文开销
  if (skillManager.listMeta().length > 0) {
    history.setSystemPrompt(SKILL_SYSTEM_PROMPT_HINT);
  }

  // 11. 创建上下文压缩器
  const compressor = createContextCompressor(config.compression);

  // 12. 创建 Agent（将上面所有组件注入）
  const agent = createAgent({
    llm,
    history,
    tools,
    logger,
    todoManager,
    compressor,
    maxContextTokens: config.compression.maxContextTokens,
  });

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

      // /skill REPL 命令处理
      // 这些命令不经过 LLM，直接操作 SkillManager
      if (trimmed.startsWith("/skill")) {
        handleSkillCommand(trimmed, skillManager, logger);
        prompt();
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

/**
 * handleSkillCommand — 处理 /skill REPL 命令
 *
 * 这些命令直接操作 SkillManager，不经过 LLM：
 * - /skill list         显示已安装的 skill 列表
 * - /skill load         重新扫描 skills/ 目录，刷新缓存
 * - /skill remove <name> 删除指定 skill
 *
 * 已知限制：/skill load 后 run_skill 的 tool description 不会动态更新
 * （注册时一次性生成），需要重启 agent 才能完全刷新。
 */
function handleSkillCommand(
  input: string,
  manager: ReturnType<typeof createSkillManager>,
  logger: ReturnType<typeof createLogger>,
): void {
  const parts = input.trim().split(/\s+/);
  const subcommand = parts[1];

  switch (subcommand) {
    case "list": {
      // 列出所有已安装的 skill
      const metas = manager.listMeta();
      if (metas.length === 0) {
        console.log("No skills loaded.");
      } else {
        console.log("Available skills:");
        for (const m of metas) {
          console.log(`  - ${m.name}: ${m.description}`);
        }
      }
      break;
    }
    case "load": {
      // 重新扫描 skills/ 目录
      manager.scan();
      const count = manager.listMeta().length;
      logger.info("Re-scanned skills: %d loaded", count);
      console.log(`Scanned skills: ${count} skill(s) loaded.`);
      // 注意：run_skill 的 tool description 不会更新，需要重启
      if (count > 0) {
        console.log(
          "Note: restart the agent to update the tool definition for LLM.",
        );
      }
      break;
    }
    case "remove": {
      // 删除指定的 skill
      const skillName = parts[2];
      if (!skillName) {
        console.log("Usage: /skill remove <name>");
        break;
      }
      const removed = manager.remove(skillName);
      if (removed) {
        logger.info("Skill removed: %s", skillName);
        console.log(`Skill "${skillName}" removed.`);
      } else {
        console.log(`Skill "${skillName}" not found.`);
      }
      break;
    }
    default:
      console.log("Usage: /skill <list|load|remove <name>>");
  }
}
