# 项目状态总览

这是 learning-claude-code-ts 项目的持久化状态文档。每次新增功能模块后更新此文件。

## 项目简介

教学用途的 TypeScript Coding Agent，递进式构建，每一步都能独立运行。

GitHub: https://github.com/pingp76/learning-claude-code-ts

## 当前状态

**已完成阶段**: 基础 REPL + LLM 对话 + bash 工具调用 + 文件操作工具 + 消息标准化 + TODO 任务管理 + 子智能体（SubAgent）+ Skill（技能）系统 + LLM 通信日志 + 上下文压缩

## 源码结构

```
src/
├── index.ts            # 入口：REPL 交互循环（readline）+ /skill REPL 命令
├── config.ts           # 从 .env 加载配置（含压缩配置）
├── logger.ts           # 分级日志（debug/info/warn/error）+ util.format 占位符替换
├── llm.ts              # LLM 客户端（OpenAI SDK + MiniMax baseURL）+ LLM 日志记录
├── llm-logger.ts       # LLM 通信日志：完整记录请求/响应到 logs/llm.log，超 1MB 清空重写
├── normalize.ts        # 消息标准化：过滤元数据、补全 tool_result、合并同角色消息
├── history.ts          # 对话历史管理（messages 数组 + system prompt 支持）
├── message-block.ts    # 消息块：压缩的原子单位，groupToBlocks/flattenToMessages + token 估算
├── compressor.ts       # 上下文压缩器：三层压缩（衰减 + 即时 + 全量）+ 状态管理
├── agent.ts            # Agent 主循环：think → act → observe + 压缩管道 + 轮次追踪
├── todo.ts             # TODO 管理器：session 级别任务列表（工厂函数 + 6 个工具）
├── skills.ts           # Skill 管理器：按需加载的 prompt 扩展（scan/invoke/remove）+ SkillToolProvider
├── debug-e2e.ts        # 端到端调试脚本（Skill+TODO+SubAgent 协作验证）
├── message-block.test.ts # 消息块测试（24 个测试用例）
├── compressor.test.ts    # 压缩器测试（18 个测试用例）
├── todo.test.ts        # TODO 管理器测试（33 个测试用例）
├── skills.test.ts      # Skill 管理器测试（25 个测试用例）
├── normalize.test.ts   # 消息标准化测试
├── index.test.ts       # 占位测试
├── history.test.ts     # history 模块测试
├── logger.test.ts      # logger 模块测试
└── tools/
    ├── types.ts        # 共享类型：ToolResult 接口
    ├── bash.ts         # bash 工具：执行 shell 命令 + 危险命令过滤（工具名: run_bash）
    ├── bash.test.ts    # bash 工具测试
    ├── files.ts        # 文件操作工具：run_read、run_write、run_edit（限工作目录）
    ├── files.test.ts   # 文件操作工具测试
    ├── subagent.ts     # 子智能体工具：run_subagent（独立上下文 + skill 支持 + 独立压缩器）
    ├── subagent.test.ts # 子智能体工具测试（13 个测试用例）
    └── registry.ts     # 工具注册表（bash + files + todo + subagent + skill 工具）
skills/
├── code-review/
│   └── SKILL.md        # 代码审查 skill（示例）
└── explain-code/
    └── SKILL.md        # 代码解释 skill（示例）
```
├── logger.ts           # 分级日志（debug/info/warn/error）+ util.format 占位符替换
├── llm.ts              # LLM 客户端（OpenAI SDK + MiniMax baseURL）+ 发送前消息标准化 + LLM 日志记录
├── llm-logger.ts       # LLM 通信日志：完整记录请求/响应到 logs/llm.log，超 1MB 清空重写
├── normalize.ts        # 消息标准化：过滤元数据、补全 tool_result、合并同角色消息
├── history.ts          # 对话历史管理（messages 数组 + system prompt 支持）
├── agent.ts            # Agent 主循环：think → act → observe + tickRound 轮次检测 + maxRounds 支持
├── todo.ts             # TODO 管理器：session 级别任务列表（工厂函数 + 6 个工具）
├── skills.ts           # Skill 管理器：按需加载的 prompt 扩展（scan/invoke/remove）+ SkillToolProvider
├── debug-e2e.ts        # 端到端调试脚本（Skill+TODO+SubAgent 协作验证）
├── todo.test.ts        # TODO 管理器测试（33 个测试用例）
├── skills.test.ts      # Skill 管理器测试（25 个测试用例）
├── normalize.test.ts   # 消息标准化测试
├── index.test.ts       # 占位测试
├── history.test.ts     # history 模块测试
├── logger.test.ts      # logger 模块测试
└── tools/
    ├── types.ts        # 共享类型：ToolResult 接口
    ├── bash.ts         # bash 工具：执行 shell 命令 + 危险命令过滤（工具名: run_bash）
    ├── bash.test.ts    # bash 工具测试
    ├── files.ts        # 文件操作工具：run_read、run_write、run_edit（限工作目录）
    ├── files.test.ts   # 文件操作工具测试
    ├── subagent.ts     # 子智能体工具：run_subagent（独立上下文 + skill 支持）
    ├── subagent.test.ts # 子智能体工具测试（13 个测试用例）
    └── registry.ts     # 工具注册表（bash + files + todo + subagent + skill 工具）
skills/
├── code-review/
│   └── SKILL.md        # 代码审查 skill（示例）
└── explain-code/
    └── SKILL.md        # 代码解释 skill（示例）
```

## 已实现功能

### Agent 核心循环 (`agent.ts`)
- 接收用户 query，存入 history
- **消息处理管道**：`getMessages() → annotateWithRounds() → normalizeMessages() → groupToBlocks() → decayOldBlocks() → [compactHistory()] → flattenToMessages() → llm.chat()`
- **轮次追踪**：agent.ts 维护 `messageRounds` 并行数组，每次 `addWithRound()` 同步记录
- 调用 LLM（传入压缩后的消息 + 工具定义）
- 处理 LLM 响应：
  - 文本回复 → 直接返回给用户
  - 工具调用 → 逐个执行，结果存入 history，继续调用 LLM
- **P1 即时压缩**：run_bash 工具的大输出自动存文件，只返回 preview
- **P0 衰减压缩**：每轮自动截断旧的工具结果
- **P2 全量压缩**：上下文超过阈值时，将历史压缩为摘要
- 循环直到 LLM 不再请求工具调用
- JSON 解析失败的容错处理（将错误告知 LLM 让其自行修正）
- **maxRounds 支持**：可选的最大循环轮数（子智能体使用），超过时强制截断并返回摘要
- **todoManager 可选**：子智能体不传 todoManager，父智能体行为不变
- **compressor 必需**：上下文压缩器通过依赖注入传入

### 消息块 (`message-block.ts`)
- **消息块是压缩操作的原子单位**：保证 tool_use/tool_result 配对不被拆分
- **三种类型**：
  - `text`：纯文本对话（user + assistant 无工具调用）
  - `tool_use`：工具调用轮次（assistant 含 tool_calls + 所有对应的 tool 消息）
  - `summary`：全量压缩产生的摘要消息
- `groupToBlocks()`：将扁平消息列表分组为消息块数组
- `flattenToMessages()`：将消息块数组还原为扁平列表（清除 `_round` 元数据）
- `estimateTokens()`：基于字符数的 token 估算（中文×1.5，英文×0.25，取较大值）
- `truncateToTokens()`：按 token 估算截断文本

### 上下文压缩 (`compressor.ts`)
- **三层压缩机制**（按优先级）：
  - **P0 衰减压缩**：`decayOldBlocks()` — 超过轮次阈值的 tool_use 块，截断 tool result content
  - **P1 即时压缩**：`compressToolResult()` — run_bash 大输出存入 `.task_outputs/`，返回 preview
  - **P2 全量压缩**：`compactHistory()` — 纯规则压缩，保留 recent K 块，其余压缩为摘要
- **消息块约束**：不拆分块、不孤立配对、不破坏 ID 关联
- **状态管理**：hasCompacted、lastSummary、recentFiles（闭包保护）
- **连续压缩**：后续压缩复用上一次 summary，避免信息退化
- **降级策略**：文件写入失败跳过压缩、全量压缩后仍超限保留最精简上下文
- **cleanup()**：清空 `.task_outputs/` 目录

### LLM 客户端 (`llm.ts`)
- 使用 OpenAI SDK，通过 baseURL 接入 MiniMax API
- 支持 function calling（工具调用）
- 接口抽象：`LLMClient { chat(messages, tools?) }`
- **消息由调用方标准化**：normalize 移至 agent.ts，llm.chat() 接收已处理的消息
- **LLM 通信日志**：可选的 `LLMLogger` 参数，记录完整请求/响应到本地文件

### LLM 通信日志 (`llm-logger.ts`)
- **完整记录原始通信**：请求（消息列表 + 工具定义）和响应（内容 + 工具调用 + 耗时）
- **不做任何截断**：消息内容、工具参数、tool_call arguments 全部完整保留
- **格式化为易读结构**：角色标签对齐、JSON 美化、缩进
- **文件策略**：固定 `logs/llm.log`，每次启动清空，超过 1MB 清空重写
- **请求-响应成对**：每组用空行 + 分隔线隔开

### 消息标准化 (`normalize.ts`)
- **过滤元数据字段**：清理 content 数组中 `_` 开头的键（如 `_timestamp`、`_id`）
- **补全缺失 tool_result**：每个 assistant 的 tool_call 都必须有对应的 tool 消息，缺失则插入占位消息
- **合并连续同角色消息**：将 user+user 或 assistant+assistant 合并为一条（OpenAI API 要求角色严格交替）

### 工具系统 (`tools/`)
- **命名规范**：所有工具名称以 `run_` 开头、全小写
- **run_bash 工具**：通过 `child_process.exec` 执行 shell 命令
  - 危险命令过滤（rm -rf、mkfs、dd、fork bomb、shutdown 等）
  - 超时 30s，最大输出 1MB
- **run_read 工具**：读取文件内容
  - 路径安全检查：限制在工作目录内，防止路径穿越
- **run_write 工具**：写入文件（覆盖），自动创建父目录
  - 路径安全检查同上
- **run_edit 工具**：编辑文件（查找全部替换）
  - `replaceAll` 行为：所有匹配项都会被替换
  - old_string 未找到时返回错误
  - 路径安全检查同上
- **注册表模式**：`ToolRegistry` 统一管理工具定义与执行函数（含 bash、files、todo、subagent、skill 五类工具）

### 子智能体 / SubAgent (`tools/subagent.ts`)
- **工具定义**：`run_subagent`，参数 `task`（必填）+ `max_rounds`（可选，默认 20）
- **核心设计**：子智能体是一个独立的 Agent 实例，拥有自己的对话历史
- **上下文隔离**：子智能体执行过程中产生的所有中间消息对父智能体不可见
- **工具集**：子智能体可使用 run_bash、run_read、run_write、run_edit、**run_skill**
  - 排除 run_subagent（防止无限递归）
  - 排除 run_todo_*（隔离上下文中用户看不到进度，maxRounds 已够用）
- **skill 支持**：子智能体加载 system prompt hint，可自主调用 run_skill 获取专业指示
- **独立压缩器**：通过 `createCompressorFn` 注入，子智能体使用独立的压缩器实例
- **循环依赖解决**：通过依赖注入 `createAgentFn` + `createCompressorFn` 打破循环
- **停止条件**：任务完成（LLM 返回文本） / 轮数上限（强制截断） / LLM 错误（返回错误信息）

### TODO 任务管理 (`todo.ts`)
- **纯 tool 驱动**：通过 6 个工具（run_todo_create、run_todo_update、run_todo_add、run_todo_remove、run_todo_list、run_todo_cancel）管理任务列表
- **session 级别**：一个 session 最多一个活跃 todo list，新建时自动取消旧的
- **状态机**：
  - TodoList：idle → active → completed/cancelled/interrupted
  - Task：pending → in_progress → completed/skipped/cancelled/interrupted
- **轮次上限**：每个 task 有 roundCount 计数器，agent 循环每次迭代 +1，达到上限（默认 10）自动中断
- **中断与恢复**：中断后 LLM 可通过 run_todo_update 恢复执行、跳过、或取消
- **自动完成检测**：所有 task 处于终态时，list 自动变为 completed
- **agent 集成**：agent.ts 在每次 LLM 调用前调用 `todoManager.tickRound()`，中断信息注入对话历史
- **格式化输出**：统一格式展示任务状态（`[ ]` `[>]` `[x]` `[-]` `[_]` `[!]`）+ task_id + 统计摘要

### Skill 技能系统 (`skills.ts`)
- **按需加载的 prompt 扩展**：Skill 不是新工具或子进程，而是通过 `run_skill` 工具注入的执行指示
- **三阶段生命周期**：发现（启动时解析 SKILL.md frontmatter）→ 注册（嵌入 run_skill description）→ 触发（LLM function call 读取 body）
- **SKILL.md 格式**：YAML frontmatter（name + description 必填）+ Markdown body（执行指示）
- **双保险策略**：增强 tool description（触发规则 + 示例）+ system prompt hint，帮助 weaker model 正确使用
- **SkillManager**：scan()、listMeta()、invoke()、remove() 四个核心方法
- **SkillToolProvider**：遵循 TodoToolProvider/SubagentToolProvider 模式，提供 run_skill 工具
- **REPL 命令**：`/skill list`（列出）、`/skill load`（重新扫描）、`/skill remove <name>`（删除）
- **懒加载**：启动时只解析 frontmatter（name + description），触发时才读取 body
- **参考规范**：Anthropic 官方 Skill 系统（github.com/anthropics/skills）

### 基础设施
- **配置** (config.ts)：从 .env 加载 API key、baseURL、模型名
- **日志** (logger.ts)：四级日志，通过 LOG_LEVEL 控制，使用 `util.format` 替换 %s/%d 占位符
- **对话历史** (history.ts)：messages 数组，支持 add/getMessages/clear/setSystemPrompt
  - `setSystemPrompt()`：独立存储 system prompt，`getMessages()` 时自动插入头部
  - 不参与消息标准化（合并、补全 tool_result 等），干净分离

## 依赖

| 包 | 用途 |
|---|---|
| `openai` | LLM API 客户端（OpenAI 兼容格式） |
| `dotenv` | 从 .env 加载环境变量 |
| `typescript` | 类型检查和编译 |
| `tsx` | 直接运行 TS 文件（开发用） |
| `vitest` | 测试框架 |
| `eslint` + `typescript-eslint` | 代码检查 |
| `prettier` | 代码格式化 |

## 配置项（.env）

| 变量 | 说明 | 示例 |
|------|------|------|
| `LLM_API_KEY` | API 密钥 | `sk-cp-...` |
| `LLM_BASE_URL` | API 基础 URL | `https://api.minimaxi.com/v1` |
| `LLM_MODEL` | 模型名称 | `MiniMax-M2.5` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `COMPRESS_TOOL_OUTPUT` | 即时压缩 token 阈值 | `2000` |
| `COMPRESS_DECAY_THRESHOLD` | 衰减压缩轮次阈值 | `3` |
| `COMPRESS_DECAY_PREVIEW` | 衰减后保留 token 数 | `100` |
| `COMPRESS_MAX_CONTEXT` | 全量压缩 token 阈值 | `80000` |
| `COMPACT_KEEP_RECENT` | 全量压缩保留消息块数 | `4` |

## 测试覆盖

| 测试文件 | 测试数 | 覆盖内容 |
|---------|-------|---------|
| `src/tools/bash.test.ts` | 9 | 危险命令拦截、正常执行、错误处理 |
| `src/tools/files.test.ts` | 17 | 路径安全检查、读写文件、编辑替换 |
| `src/normalize.test.ts` | 10 | 元数据过滤、tool_result 补全、消息合并 |
| `src/history.test.ts` | 4 | 增删、返回副本、清空 |
| `src/logger.test.ts` | 1 | 日志级别过滤 |
| `src/todo.test.ts` | 33 | 创建/更新/添加/删除/取消、轮次中断与恢复、格式化输出、完整流程 |
| `src/tools/subagent.test.ts` | 13 | 工具定义、参数校验、成功/失败路径、max_rounds、轮数上限、过滤注册表 |
| `src/skills.test.ts` | 25 | frontmatter 解析、目录扫描、skill 触发/删除、工具描述构建、provider、system prompt 常量 |
| `src/message-block.test.ts` | 24 | 消息块分组、还原、_round 传递与清除、round-trip 一致性、token 估算 |
| `src/compressor.test.ts` | 18 | 衰减压缩（近期/旧/边界）、即时压缩（小/大/降级）、全量压缩（摘要/连续/状态） |
| `src/index.test.ts` | 1 | 占位 |

## 设计模式

- **工厂函数 + 闭包**：所有模块通过 `createXxx()` 创建，内部状态闭包保护
- **依赖注入**：Agent 通过参数接收所有依赖（llm, history, tools, logger）
- **接口驱动**：LLMClient、Logger、History、ToolRegistry 均通过 interface 定义
- **工具注册表**：新增工具只需 register()，无需修改 agent 代码
- **命名规范**：所有工具名以 `run_` 前缀、全小写

## 待实现 / 未来方向

（按需在后续 lesson 中实现，完成后更新此列表）

- 流式输出（streaming response）
- 多轮对话中的 system prompt 管理
- 更丰富的工具集（grep、glob、web fetch 等）
- Skill 脚本执行支持（dependencies 字段、base path 引用脚本）
- 用户级 skill 目录（`~/.claude/skills/`）
- 对话创建 skill（LLM 自动在 skills/ 下创建目录和 SKILL.md）
