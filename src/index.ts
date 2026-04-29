/**
 * index.ts — 组装根（Composition Root）
 *
 * 职责：初始化所有组件并将它们连接在一起，然后启动 REPL。
 *
 * 什么是组装根？
 * - 组装根是依赖注入的"接线层"：它知道所有组件，负责创建它们并传递依赖
 * - 它不包含业务逻辑，只做"new A(new B(new C()))"这样的组装工作
 * - 这是依赖注入模式的最佳实践：所有依赖关系集中在一个地方管理
 *
 * 组件初始化顺序（每步只依赖前面已创建的组件，无循环依赖）：
 * config → logger → terminal → llm → history → skill → subagent → tools →
 * compressor → permissionManager → agent → commands → repl
 */

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
import { createRepl } from "./repl.js";
import {
  createCliCommandRegistry,
  createSkillCliCommand,
  createModeCliCommand,
} from "./cli-commands.js";
import { createTerminal } from "./terminal.js";
import { createPermissionManager } from "./permission.js";

/**
 * main — 主函数
 *
 * 纯组装逻辑：创建组件 → 注入依赖 → 启动 REPL。
 */
async function main() {
  // 1. 加载配置（从 .env 文件）
  const config = loadConfig();

  // 2. 创建日志器
  const logger = createLogger(config.logLevel);

  // 3. 创建终端（统一 readline，供 REPL 和权限确认共享）
  const terminal = createTerminal();

  // 4. 创建 LLM 客户端
  const llmLogger = createLLMLogger();
  const llm = createLLMClient(config, llmLogger);

  // 5. 创建对话历史管理器
  const history = createHistory();

  // 6. 创建 todo 管理器
  const todoManager = createTodoManager();

  // 7. 创建 Skill 管理器并扫描 skills/ 目录
  const skillsDir = resolve(process.cwd(), "skills");
  const skillManager = createSkillManager(skillsDir);
  if (existsSync(skillsDir)) {
    skillManager.scan();
    logger.info("Loaded %d skills", skillManager.listMeta().length);
  } else {
    logger.info("No skills/ directory found, skills disabled");
  }

  // 8. 创建权限管理器
  const permissionManager = createPermissionManager(process.cwd());

  // 9. 创建 skill 工具提供者
  const skillProvider = createSkillToolProvider(skillManager);

  // 10. 创建子智能体工具提供者
  //     注入 permissionManager（子智能体继承同一权限模式）
  const subagentProvider = createSubagentToolProvider({
    llm,
    logger,
    createFilteredRegistry: () =>
      createToolRegistry(undefined, undefined, skillProvider),
    createAgentFn: createAgent,
    createCompressorFn: () => createContextCompressor(config.compression),
    permissionManager,
  });

  // 11. 创建工具注册表
  const tools = createToolRegistry(
    todoManager,
    subagentProvider,
    skillProvider,
  );

  // 12. 设置 system prompt（有 skill 时才注入）
  if (skillManager.listMeta().length > 0) {
    history.setSystemPrompt(SKILL_SYSTEM_PROMPT_HINT);
  }

  // 13. 创建上下文压缩器
  const compressor = createContextCompressor(config.compression);

  // 14. 创建 Agent（注入权限管理器和确认回调）
  const agent = createAgent({
    llm,
    history,
    tools,
    logger,
    todoManager,
    compressor,
    maxContextTokens: config.compression.maxContextTokens,
    permissionManager,
    askUserFn: terminal.askUser.bind(terminal),
  });

  // 15. 注册 CLI 命令
  const commandRegistry = createCliCommandRegistry();
  commandRegistry.register(createSkillCliCommand(skillManager, logger));
  commandRegistry.register(createModeCliCommand(permissionManager, logger));

  // 16. 创建并启动 REPL
  const repl = createRepl({ agent, logger, commands: commandRegistry, terminal });
  logger.info("Agent started (model: %s)", config.model);
  repl.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
