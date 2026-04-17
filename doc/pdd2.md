# Lesson 1：基本对话 Agent 循环

## 目标

实现一个最简的 Coding Agent REPL：用户从命令行输入 → 调用 LLM → 处理响应（包括工具调用）→ 循环直到输入 exit。

## 模型配置

通过 `.env` 文件管理，不硬编码在代码中。

```
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_MODEL=MiniMax-M2.5
LOG_LEVEL=info
```

- 使用 OpenAI 兼容格式的 API，通过 `openai` SDK + 自定义 baseURL 接入 MiniMax
- `.env` 已加入 `.gitignore`，不会泄露密钥

## 工作流程

```
┌─────────────────────────────────────────────┐
│  用户输入 query                              │
│       ↓                                     │
│  存入 history（role: user）                  │
│       ↓                                     │
│  ┌─→ 调用 LLM（传入 history + tools 定义）   │
│  │      ↓                                   │
│  │  将 LLM 响应存入 history（role: assistant）│
│  │      ↓                                   │
│  │  有工具调用？                              │
│  │  ├── 是 → 执行工具 → 结果存入 history    │
│  │  │        （role: tool）→ 回到 ↑          │
│  │  └── 否 → 打印文本回复给用户              │
│       ↓                                     │
│  等待下一次用户输入（exit 退出）              │
└─────────────────────────────────────────────┘
```

## 项目结构

```
src/
├── index.ts            # 入口：初始化组件，启动 REPL 循环
├── config.ts           # 从 .env 加载配置（API key、baseURL、模型名）
├── logger.ts           # 可调级别的日志工具（debug/info/warn/error）
├── llm.ts              # LLM 客户端：封装 openai SDK，通过 baseURL 接入 MiniMax
├── history.ts          # 对话历史管理：维护 messages 数组
├── agent.ts            # Agent 主循环：think → act → observe
└── tools/
    ├── bash.ts         # bash 工具：执行 shell 命令 + 危险命令过滤
    └── registry.ts     # 工具注册表：统一管理工具定义与执行函数
```

### 各模块职责

| 模块 | 职责 | 关键接口 |
|------|------|----------|
| `config.ts` | 从 .env 加载配置 | `loadConfig()` → `Config` |
| `logger.ts` | 分级日志输出 | `createLogger(level)` → `Logger` |
| `llm.ts` | 封装 LLM API 调用 | `createLLMClient(config)` → `LLMClient.chat()` |
| `history.ts` | 管理对话上下文 | `createHistory()` → `{ add, getMessages, clear }` |
| `tools/bash.ts` | 执行 shell 命令 | `executeBash(command)` → `ToolResult` |
| `tools/registry.ts` | 注册和查找工具 | `createToolRegistry()` → `{ getToolDefinitions, getExecutor }` |
| `agent.ts` | Agent 主循环 | `createAgent(deps)` → `Agent.run(query)` |
| `index.ts` | 入口和 REPL | readline 循环读取用户输入 |

## 核心设计模式

### 1. 工厂函数 + 闭包

所有模块都使用 `createXxx()` 工厂函数创建实例，内部状态通过闭包保护：

```typescript
export function createHistory(): History {
  const messages: Message[] = [];  // 闭包私有变量
  return {
    add(msg) { messages.push(msg); },
    getMessages() { return [...messages]; },  // 返回副本
  };
}
```

好处：不需要 class，不需要 this，TypeScript 类型自动推导。

### 2. 依赖注入

Agent 通过参数注入所有依赖，而不是在内部创建：

```typescript
const agent = createAgent({ llm, history, tools, logger });
```

好处：
- 测试时可以传入 mock 对象
- 替换组件不需要改 agent 代码

### 3. 接口定义行为

每个模块先定义 interface，再实现。调用者只依赖接口，不依赖实现：

```typescript
interface LLMClient {
  chat(messages, tools?): Promise<LLMResponse>;
}
```

### 4. 工具注册表模式

新工具只需要注册一个 ToolEntry，不需要修改 agent 代码：

```typescript
register({
  definition: bashToolDefinition,  // 告诉 LLM 工具的接口
  execute: async (args) => ...,     // 实际执行逻辑
});
```

## Agent 循环详解

Agent 的核心是一个无限循环，每轮做三件事：

1. **THINK**：把对话历史发给 LLM，让它思考下一步该做什么
2. **ACT**：LLM 可能返回文本回复，也可能请求调用工具
3. **OBSERVE**：
   - 如果是工具调用 → 执行工具，把结果加入历史，回到 THINK
   - 如果是文本回复 → 返回给用户，循环结束

一个用户问题可能触发多轮 LLM 调用，例如：
- 第 1 轮：LLM 调用 bash 查看文件列表
- 第 2 轮：LLM 看到列表后，调用 bash 读取某个文件
- 第 3 轮：LLM 根据文件内容，生成最终的文字回复

## Bash 工具安全机制

使用正则表达式黑名单过滤危险命令：

- `rm -rf`、`mkfs`、`dd of=/dev/` 等破坏性操作
- `shutdown`、`reboot`、`poweroff` 等系统控制命令
- `iptables`、`ufw` 等防火墙操作
- fork bomb 等恶意模式

被拦截的命令会返回错误信息给 LLM，LLM 可以调整策略尝试其他方案。

## 测试

| 测试文件 | 覆盖内容 |
|---------|---------|
| `src/history.test.ts` | 历史增删、返回副本、清空 |
| `src/logger.test.ts` | 日志级别过滤 |
| `src/tools/bash.test.ts` | 危险命令拦截、正常命令执行、错误处理 |

运行测试：`npm test`
