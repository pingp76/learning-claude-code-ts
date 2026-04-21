# 实现 SubAgent 功能（作为工具）

## 动机
父智能体在执行旁支任务（如搜索代码、分析文件、跑测试）时，中间过程会产生大量
工具调用消息，污染主对话上下文。SubAgent 将这些中间过程隔离到独立的上下文中，
只将最终结果返回给父智能体。

## 核心设计
SubAgent 本质是一个名为 `run_subagent` 的工具，其执行函数内部创建一个新的
Agent 实例来独立运行任务。

## 数据流

```
父智能体 LLM 决定调用 run_subagent(task, max_rounds)
     │
     ▼
run_subagent 工具执行函数：
  1. 创建独立的 History（空，或可选拷贝父级历史作为种子）
  2. 创建过滤后的 ToolRegistry（排除 run_subagent 和 run_todo_*）
  3. 创建子 Agent 实例（复用父级的 llm 和 logger）
  4. 将 task 作为 query 传给子 Agent
     │
     ▼
子 Agent 独立运行 think → act → observe 循环
  - 有自己的轮数上限（默认 20，由参数覆盖）
  - LLM 调用失败 → 将错误信息作为 tool_result 返回
  - 达到轮数上限 → 将已有中间结果总结后返回
     │
     ▼
子 Agent 返回最终文本 → 作为 run_subagent 工具的 ToolResult
     │
     ▼
父智能体在 history 中看到 tool_result，继续后续推理
```

## 接口设计

### run_subagent 工具参数
- task (string, 必填)：子智能体需要完成的具体任务描述
- max_rounds (number, 可选, 默认 20)：子智能体最大循环轮数

### 子智能体的依赖
- LLM Client：复用父级的（共享连接和配置）
- Logger：复用父级的（子智能体日志带前缀标识）
- History：独立新建（不与父级共享引用）
- ToolRegistry：过滤后新建（排除递归风险工具）

### 工具过滤规则
- 保留：run_bash、run_read、run_write、run_edit
- 排除：run_subagent（防止无限递归）、run_todo_* 全部（防止干扰父级任务状态）

## 停止条件
- 任务完成：子 Agent 的 run() 返回文本回复（LLM 不再请求工具调用）
- 轮数上限：达到 max_rounds 时，强制截断并总结已有结果
- LLM 错误：连续 LLM 调用失败时，返回最后一次的错误信息

## 限制
- 子智能体只能返回 ToolResult（output + error），不能修改父智能体的上下文
- 子智能体不能创建其他子智能体（通过工具过滤保证）
- 父智能体在子智能体运行期间处于阻塞状态（同步等待结果）
- 父智能体应避免并行创建多个修改同一文件的子智能体（资源冲突由调用者负责）

## 与现有架构的集成
- 在 tools/registry.ts 中新增 run_subagent 工具注册
- 子智能体复用 createAgent() 工厂函数，传入过滤后的依赖
- 新增 src/tools/subagent.ts 实现工具定义和执行逻辑
