# 项目状态总览

这是 learning-claude-code-ts 项目的持久化状态文档。每次新增功能模块后更新此文件。

## 项目简介

教学用途的 TypeScript Coding Agent，递进式构建，每一步都能独立运行。

GitHub: https://github.com/pingp76/learning-claude-code-ts

## 当前状态

**已完成阶段**: 基础 REPL + LLM 对话 + bash 工具调用 + 文件操作工具 + 消息标准化 + TODO 任务管理 + 子智能体（SubAgent）

## 源码结构

```
src/
├── index.ts            # 入口：REPL 交互循环（readline）
├── config.ts           # 从 .env 加载配置
├── logger.ts           # 分级日志（debug/info/warn/error）
├── llm.ts              # LLM 客户端（OpenAI SDK + MiniMax baseURL）+ 发送前消息标准化
├── normalize.ts        # 消息标准化：过滤元数据、补全 tool_result、合并同角色消息
├── history.ts          # 对话历史管理（messages 数组）
├── agent.ts            # Agent 主循环：think → act → observe + tickRound 轮次检测 + maxRounds 支持
├── todo.ts             # TODO 管理器：session 级别任务列表（工厂函数 + 6 个工具）
├── todo.test.ts        # TODO 管理器测试（33 个测试用例）
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
    ├── subagent.ts     # 子智能体工具：run_subagent（独立上下文，隔离执行旁支任务）
    ├── subagent.test.ts # 子智能体工具测试（13 个测试用例）
    └── registry.ts     # 工具注册表（bash + files + todo + subagent 工具）
```

## 已实现功能

### Agent 核心循环 (`agent.ts`)
- 接收用户 query，存入 history
- 调用 LLM（传入完整 history + 工具定义）
- 处理 LLM 响应：
  - 文本回复 → 直接返回给用户
  - 工具调用 → 执行工具，结果存入 history，继续调用 LLM
- 循环直到 LLM 不再请求工具调用
- JSON 解析失败的容错处理（将错误告知 LLM 让其自行修正）
- **maxRounds 支持**：可选的最大循环轮数（子智能体使用），超过时强制截断并返回摘要
- **todoManager 可选**：子智能体不传 todoManager，父智能体行为不变

### LLM 客户端 (`llm.ts`)
- 使用 OpenAI SDK，通过 baseURL 接入 MiniMax API
- 支持 function calling（工具调用）
- 接口抽象：`LLMClient { chat(messages, tools?) }`
- **发送前消息标准化**：调用 `normalizeMessages()` 处理消息

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
- **注册表模式**：`ToolRegistry` 统一管理工具定义与执行函数

### 子智能体 / SubAgent (`tools/subagent.ts`)
- **工具定义**：`run_subagent`，参数 `task`（必填）+ `max_rounds`（可选，默认 20）
- **核心设计**：子智能体是一个独立的 Agent 实例，拥有自己的对话历史
- **上下文隔离**：子智能体执行过程中产生的所有中间消息对父智能体不可见
- **工具过滤**：子智能体只能使用 run_bash、run_read、run_write、run_edit
  - 排除 run_subagent（防止无限递归）
  - 排除 run_todo_*（防止干扰父级任务状态）
- **循环依赖解决**：通过依赖注入 `createAgentFn` 打破 agent.ts ↔ registry.ts ↔ subagent.ts 的循环
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
- **格式化输出**：统一格式展示任务状态（`[ ]` `[>]` `[x]` `[-]` `[_]` `[!]`）+ 统计摘要

### 基础设施
- **配置** (config.ts)：从 .env 加载 API key、baseURL、模型名
- **日志** (logger.ts)：四级日志，通过 LOG_LEVEL 控制
- **对话历史** (history.ts)：messages 数组，支持 add/getMessages/clear

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
