/**
 * debug-e2e.ts — 端到端集成调试脚本
 *
 * 用途：手动触发，验证 Skill + TODO + SubAgent 三者协作流程。
 * 不参与自动化测试（npm test 不会运行此文件）。
 *
 * 运行方式：
 *   npx tsx src/debug-e2e.ts
 *
 * 前提条件：
 *   - .env 文件已配置 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL
 *   - skills/ 目录下有 code-review skill
 *   - src/agent.ts 和 src/tools/registry.ts 文件存在
 *
 * 验证流程：
 *   用户输入：
 *     "帮我审查 src/agent.ts 和 src/tools/registry.ts 的代码质量，
 *      用 TODO 列表跟踪进度，对每个文件的审查使用独立的子智能体"
 *
 *   预期 LLM 行为：
 *     1. 调用 run_skill({ name: "code-review" })           ← Skill 触发
 *     2. 调用 run_todo_create + run_todo_add × 3           ← TODO 创建
 *     3. 调用 run_subagent({ task: "审查 agent.ts..." })    ← 子智能体 1
 *     4. 调用 run_todo_update(task 1: completed)
 *     5. 调用 run_subagent({ task: "审查 registry.ts..." }) ← 子智能体 2
 *     6. 调用 run_todo_update(task 2: completed)
 *     7. 输出汇总审查报告                                    ← 最终回复
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

// ============================================================
// 调试用的测试输入
// ============================================================

const TEST_QUERY =
  "帮我审查 src/agent.ts 和 src/tools/registry.ts 的代码质量，" +
  "用 TODO 列表跟踪进度，对每个文件的审查使用独立的子智能体。生成 TODO 列表之后，等我确认了再开始执行计划";

// ============================================================
// 初始化所有组件（与 index.ts 完全一致）
// ============================================================

async function main() {
  console.log("=".repeat(60));
  console.log("端到端集成调试：Skill + TODO + SubAgent");
  console.log("=".repeat(60));

  // 1. 加载配置
  const config = loadConfig();
  // 强制使用 debug 级别，确保看到所有日志
  const logger = createLogger("debug");

  console.log(`\n模型: ${config.model}`);

  // 2. 创建 LLM 客户端（带通信日志）
  const llmLogger = createLLMLogger();
  const llm = createLLMClient(config, llmLogger);

  // 3. 创建对话历史
  const history = createHistory();

  // 4. 创建 TODO 管理器
  const todoManager = createTodoManager();

  // 5. 创建 Skill 管理器
  const skillsDir = resolve(process.cwd(), "skills");
  const skillManager = createSkillManager(skillsDir);
  if (existsSync(skillsDir)) {
    skillManager.scan();
  }

  // 打印已加载的 skill 列表
  const skillMetas = skillManager.listMeta();
  console.log(`\n已加载 ${skillMetas.length} 个 skill:`);
  for (const m of skillMetas) {
    console.log(`  - ${m.name}: ${m.description}`);
  }

  // 6. 创建子智能体提供者
  const subagentProvider = createSubagentToolProvider({
    llm,
    logger,
    createFilteredRegistry: () => createToolRegistry(),
    createAgentFn: createAgent,
  });

  // 7. 创建 skill 工具提供者
  const skillProvider = createSkillToolProvider(skillManager);

  // 8. 创建工具注册表
  const tools = createToolRegistry(todoManager, subagentProvider, skillProvider);

  // 打印已注册的工具列表
  const toolDefs = tools.getToolDefinitions();
  console.log(`\n已注册 ${toolDefs.length} 个工具:`);
  for (const t of toolDefs) {
    console.log(`  - ${t.function?.name}`);
  }

  // 9. 设置 system prompt
  if (skillMetas.length > 0) {
    history.setSystemPrompt(SKILL_SYSTEM_PROMPT_HINT);
    console.log(`\nSystem prompt 已设置`);
  }

  // 10. 创建 Agent
  const agent = createAgent({ llm, history, tools, logger, todoManager });

  // ============================================================
  // 执行测试查询
  // ============================================================

  console.log("\n" + "-".repeat(60));
  console.log(`用户输入: ${TEST_QUERY}`);
  console.log("-".repeat(60) + "\n");

  const startTime = Date.now();

  try {
    const response = await agent.run(TEST_QUERY);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n" + "=".repeat(60));
    console.log(`Agent 最终回复（耗时 ${elapsed}s）:`);
    console.log("=".repeat(60));
    console.log(response);
  } catch (err) {
    console.error("\n执行出错:", err);
  }

  // ============================================================
  // 打印调试摘要
  // ============================================================

  console.log("\n" + "=".repeat(60));
  console.log("调试摘要");
  console.log("=".repeat(60));

  // 对话历史中的工具调用统计
  const messages = history.getMessages();
  const toolCalls: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        toolCalls.push(tc.function.name);
      }
    }
  }

  console.log(`\n总消息数: ${messages.length}`);
  console.log(`工具调用数: ${toolCalls.length}`);
  console.log("工具调用序列:");
  toolCalls.forEach((name, i) => {
    console.log(`  ${i + 1}. ${name}`);
  });

  // 验证关键行为
  console.log("\n关键行为验证:");
  const hasSkill = toolCalls.some((n) => n === "run_skill");
  const hasTodo = toolCalls.some((n) => n.startsWith("run_todo_"));
  const hasSubagent = toolCalls.some((n) => n === "run_subagent");

  console.log(
    `  Skill 触发 (run_skill):           ${hasSkill ? "✅ 已触发" : "❌ 未触发"}`,
  );
  console.log(
    `  TODO 管理 (run_todo_*):           ${hasTodo ? "✅ 已使用" : "❌ 未使用"}`,
  );
  console.log(
    `  子智能体 (run_subagent):           ${hasSubagent ? "✅ 已使用" : "❌ 未使用"}`,
  );
  console.log(
    `  三者协作:                          ${hasSkill && hasTodo && hasSubagent ? "✅ 完整" : "⚠️ 不完整"}`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
