# 重构建议（基于当前代码与架构）

本文面向后续参与重构的同学，目标不是推翻现有实现，而是在保持“教学项目、逐步演进、每步都可运行”前提下，降低模块耦合、减少隐式状态、让后续功能更容易继续叠加。

## 一、先给整体评价

当前项目的优点很明确：

1. **模块边界初步清晰**：`agent.ts`、`history.ts`、`llm.ts`、`tools/`、`skills.ts`、`todo.ts`、`compressor.ts` 已经形成了较清楚的职责划分。
2. **工厂函数 + 依赖注入思路是对的**：这让测试和后续替换实现都比较容易。
3. **教学可读性强**：很多模块用大段中文注释解释“为什么这样做”，对学习者很友好。
4. **测试意识较好**：核心模块大多已有测试，不是“先堆功能再补测试”。

但如果继续往下加能力（streaming、更多工具、更多 provider、长期 session、真正并行的子任务），现在的结构会逐渐出现以下问题：

- Agent 主循环开始承担过多职责。
- 一些“内部约定”没有沉淀成稳定接口，而是分散在多个模块之间。
- 目前很多能力是“能工作”，但还没有提炼到“容易维护、容易扩展”的层次。

所以当前更适合做**结构性收束**，而不是继续横向堆功能。

---

## 二、最值得优先处理的几个问题

## 1. `agent.ts` 过重，已经成为事实上的“协调器 + 状态中心 + 容错层”

参考位置：`src/agent.ts`

当前 `createAgent()` 里同时负责了：

- 用户消息入历史
- 轮次计数
- TODO 中断注入
- 消息 annotate / normalize / group / decay / compact / flatten
- LLM 调用
- tool call 解析
- JSON 参数解析容错
- 工具执行
- bash 输出二次压缩
- tool result 回写历史
- 最大轮次截断

这对教学第一阶段是合理的，因为它能让读者一眼看到 Agent loop 的全貌；但继续演进时会有三个问题：

1. **测试粒度变粗**：很多行为只能通过集成测试覆盖，很难局部验证。
2. **修改成本变高**：加一个 streaming、retry、parallel tool call，都会碰 `agent.ts` 主循环。
3. **错误边界模糊**：压缩失败、工具参数解析失败、工具执行失败、LLM 失败，都混在一个循环里降级处理。

### 建议方向

把 `agent.ts` 继续拆成“主循环 + 若干明确步骤函数”，但仍保留单文件可读性，避免过度抽象。

建议拆出的函数形态：

- `prepareMessagesForLLM()`
  - 负责 annotate / normalize / group / decay / compact / flatten
- `executeToolCalls()`
  - 负责 tool call 的解析、执行、tool result 回写
- `buildRoundLimitResponse()`
  - 负责子智能体超轮次时的返回策略
- `appendAssistantMessage()` / `appendToolMessage()`
  - 负责 history + round 的同步写入

### 目标

不是把 `agent.ts` 拆成很多文件，而是先把**逻辑块显式化**。这样读者仍能顺着主循环看懂，同时后续重构者能单独替换某一步。

---

## 2. `history` 与 `messageRounds` 双轨并行，状态一致性依赖人工维护

参考位置：`src/agent.ts:90-130`、`src/history.ts`

当前轮次信息没有存在 `history` 中，而是由 `agent.ts` 维护一个平行数组：

- `history` 存消息
- `messageRounds` 存每条消息对应 round
- 通过 `addWithRound()` 手动保证同步

这在规模小时可行，但这是一个典型的**隐式耦合点**：

- 任何绕过 `addWithRound()` 直接 `history.add()` 的地方，都会破坏对齐。
- `system prompt` 是否参与索引偏移，也需要调用方自己记住。
- 未来如果出现“删除消息”“插入摘要消息”“消息重排”，平行数组会更脆弱。

### 建议方向

把“消息 + 元信息”变成统一存储结构，而不是把元信息挂在外部数组里。

可选方案：

#### 方案 A：History 内部存 `StoredMessage`

例如：

- `message: ChatCompletionMessageParam`
- `round?: number`
- `kind?: "system" | "dialog" | "tool" | "summary"`

然后：

- `history.add(message, { round })`
- `history.getMessages()` 负责输出纯 OpenAI 消息
- `history.getEntries()` 供压缩或调试模块读取结构化条目

#### 方案 B：保留现有 `History` 接口，但新增 `ConversationStore`

如果不想过早改 `history.ts`，可以新增一个更高层的 store，让 Agent 只操作 store，store 再负责投影出普通 messages。

### 优先建议

教学项目里，**方案 A 更直接**，因为概念更少，学生更容易理解“消息对象里同时带着元信息”。

---

## 3. 压缩链路职责很多，但接口还是偏“脚本式”而不是“管道式”

参考位置：`src/compressor.ts`、`src/message-block.ts`、`src/agent.ts:184-221`

当前压缩设计已经很接近一个独立子系统，但还存在几个问题：

### 3.1 压缩相关知识分散在多个模块

现在谁知道压缩规则？答案是分散的：

- `agent.ts` 知道什么时候触发 P0 / P2
- `compressor.ts` 知道如何做 P0 / P1 / P2
- `message-block.ts` 知道块结构和 token 估算
- `agent.ts` 又额外知道 `run_bash` 结果需要走 P1

也就是说，**调用时机和压缩策略被拆散了**。

### 3.2 `compressToolResult()` 对工具名有硬编码依赖

`agent.ts` 里有：只对 `run_bash` 走 P1 即时压缩。

这意味着：

- 压缩器本身不是“面向输出大小”的，而是“面向某个工具名”的。
- 以后加入 `run_grep`、`run_web_fetch`、`run_search_code` 等大输出工具时，策略会继续散落在 Agent 里。

### 建议方向

把压缩改成更明确的两层接口：

#### 第一层：会话压缩
- 输入：结构化消息/消息块
- 输出：给 LLM 的压缩后消息

#### 第二层：工具结果压缩
- 输入：`{ toolName, toolCallId, output }`
- 输出：压缩后的 tool result

这样由压缩器自己决定：

- 哪些工具需要落盘
- 按什么阈值落盘
- 返回什么 preview 格式

而不是由 `agent.ts` 写死 `if (fnName === "run_bash")`。

### 额外建议

`compactHistory()` 现在本质上是规则摘要器，但它返回的是新的 `summary` message block。后续可以考虑把它显式命名成：

- `compactBlocksToSummary()`
- `summarizeOldBlocks()`

让读者一眼知道它不是“通用压缩”，而是“规则化摘要”。

---

## 4. `index.ts` 已经开始承担组装根之外的交互逻辑

参考位置：`src/index.ts`

`index.ts` 现在除了依赖组装，还负责：

- REPL 输入循环
- `exit` 命令
- `/skill` 命令分发
- 展示输出
- 错误兜底

对于当前规模还可以，但以后如果继续加：

- `/todo`
- `/history`
- `/compress`
- `/config`
- streaming 输出
- 多行输入

那么 `index.ts` 会从“组装根”逐渐变成“第二个 agent.ts”。

### 建议方向

将 CLI 相关逻辑从组装逻辑中分离：

- `bootstrap`：只做依赖创建与接线
- `repl`：只处理交互循环
- `commands/skill-command`：只处理 `/skill` 命令

### 价值

这类拆分对教学也有帮助，因为它能顺便展示一个非常常见的工程化概念：

- **composition root（组装根）**
- **application service（应用协调）**
- **adapter / CLI layer（终端适配层）**

---

## 5. Tool Registry 还比较薄，缺少统一的参数解码层

参考位置：`src/tools/registry.ts`

当前 registry 的职责主要是：

- 存工具定义
- 根据名字取执行器

但工具参数目前是这样流动的：

1. LLM 返回 JSON 字符串
2. `agent.ts` 统一 `JSON.parse`
3. registry 返回 `execute(args)`
4. 各工具自己从 `args["path"]`、`args["command"]` 里取字段

这会带来两个问题：

1. **参数类型不真实**：例如 todo 的 `tasks` 实际是数组，但签名仍是 `Record<string, string>`。
2. **参数校验散落**：有的在 Agent 层，有的在 tool 层，有的没有。

### 建议方向

把“工具参数解析”下沉到工具注册项。

可以把 ToolEntry 变成类似：

- `definition`
- `parseArgs(raw: string): ParsedArgs | Error`
- `execute(parsedArgs): Promise<ToolResult>`

或者至少改成：

- `ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult>`

先把假的 `Record<string, string>` 改掉。

### 这是一个很值得优先做的小重构

因为它改动不算大，但能明显改善：

- 类型可信度
- tool provider 设计一致性
- 后续增加复杂参数结构时的可维护性

---

## 6. Skill 系统的教学价值很高，但“动态更新不生效”是明显的架构味道

参考位置：`src/skills.ts`、`src/index.ts:148-249`

当前已知限制是：

- `/skill load` 重新扫描后，`run_skill` 的 tool description 不会更新
- 需要重启 agent 才能让 LLM 看到新 skill 列表

这说明目前的 `run_skill` 定义是**启动时静态快照**，而 SkillManager 是动态状态。

这是一个典型的“缓存和数据源不同步”问题。

### 建议方向

有两条路线：

#### 路线 A：接受静态快照，但把行为收束得更明确

如果项目仍以教学简洁为主，可以明确规定：

- skill 列表只在启动时加载一次
- `/skill load` 只更新本地缓存与命令行查看，不承诺更新给 LLM

这样至少语义一致，不会让人误以为它是热更新系统。

#### 路线 B：让 ToolRegistry 支持“动态取定义”

如果要支持热更新，则 registry 不应只缓存静态 definition，而应允许 provider 每次按当前状态产出 tool definition。

例如：

- `getToolDefinitions()` 动态从 provider 拉取
- `run_skill` description 每次基于 `manager.listMeta()` 生成

### 我更推荐路线 A 作为近期方案

因为路线 B 会牵涉 registry 设计调整，而当前项目还在教学阶段，先把语义收紧比提早做“热更新架构”更重要。

---

## 7. `skills.ts` 的职责略杂：既做仓库扫描，也做运行时 tool provider，还做删除文件系统目录

参考位置：`src/skills.ts`

当前 `skills.ts` 包含：

- frontmatter 解析
- 目录扫描
- 缓存管理
- invoke 内容构造
- remove 删除目录
- tool description 生成
- tool provider 生成
- system prompt 常量

这对功能初期很方便，但后面会形成一个“胖模块”。

### 建议方向

后续可以按关注点拆成三层：

1. `skill-loader`：负责扫目录、解析 `SKILL.md`
2. `skill-manager`：负责缓存、invoke、remove 等运行时操作
3. `skill-tool-provider`：负责暴露 `run_skill` 工具

### 注意

这不是最优先重构项。因为虽然文件偏大，但内部主题仍集中，教学上还算能接受。优先级低于 Agent、History、Registry。

---

## 8. TODO 系统功能完整，但状态机和输出格式耦合得比较紧

参考位置：`src/todo.ts`

`todo.ts` 当前同时负责：

- 状态机
- task 操作
- list 操作
- round limit 中断策略
- 展示格式（含符号）
- tool provider

这会导致后续如果要支持：

- 不同输出视图
- 给 LLM 的紧凑格式 vs 给用户的友好格式
- 序列化保存
- Web UI 展示

就会比较难拆。

### 建议方向

可以把 TODO 拆成三层概念：

1. **domain**：Task / TodoList / 状态转换规则
2. **service**：create/update/add/remove/cancel/tickRound
3. **presentation**：formatTask / formatTodoList

### 为什么这项可以稍后做

因为当前 TODO 功能边界很稳定，改动频率不一定高。它属于“结构上应该更干净”，但暂时还不是主阻塞点。

---

## 9. 注释对教学友好，但开始出现“实现重复解释”和“维护成本偏高”的风险

参考位置：几乎全仓

这个项目有一个特殊约束：**代码必须包含详细中文注释，方便教学理解**。这没有问题，而且是这个仓库的重要特色。

但目前部分文件已经出现：

- 文件头很长
- 函数头很长
- 行内注释也很多
- 注释和实现形成重复叙述

当代码继续演进时，最容易先过期的不是代码，而是这些解释。

### 建议方向

不是减少中文注释，而是**调整注释层级**：

- 文件头：讲这个模块的职责和边界
- 关键函数：讲输入/输出和设计原因
- 代码块内：只注释不直观的点
- 避免每一行都翻译成自然语言

### 一个简单判断标准

如果把某段注释删掉，读者是否会失去“为什么这么设计”的信息？

- 如果会，保留。
- 如果只是把代码字面意思重复一遍，可以删或合并。

教学项目真正该保留的是**设计解释**，不是**逐行口译**。

---

## 三、建议的重构优先级

## P0：建议尽快做（收益最高）

### ~~P0-1. 收敛 `agent.ts` 内部职责~~ ✅ 已完成
**完成时间**：2026-04-27
**改动**：从 `run()` 中提取 `prepareMessages()`、`handleToolCalls()`、`buildRoundLimitResponse()`、`appendMessage()` 四个闭包函数，主循环骨架从 ~190 行降至 ~40 行。不改变外部接口，157 个测试全部通过。
**遗留**：提取的函数仍是闭包，无法独立单元测试。如需补充测试，需将函数改为可导出的纯函数，或新增 `agent.test.ts` 做集成级验证。

### ~~P0-2. 统一消息与 round 元信息存储~~ ✅ 已完成
**完成时间**：2026-04-27
**改动**：在 `history.ts` 中新增 `HistoryEntry` 类型和 `getEntries()`/`getSystemPrompt()` 方法，`add()` 支持可选的 `meta: { round }` 参数。`agent.ts` 删除了 `messageRounds` 平行数组和 `annotateWithRounds()` 函数，`prepareMessages()` 改为从 `getEntries()` 读取 round 元信息。不改变外部接口，166 个测试全部通过。
**收益**：round 元信息由 history 统一管理，消除了平行数组的失同步风险，`annotateWithRounds()` 的 system prompt 偏移计算也被彻底消除。

### ~~P0-3. 修正工具参数类型~~ ✅ 已完成
**完成时间**：2026-04-27
**改动**：`ToolExecutor` 类型从 `Record<string, string>` 升级为 `Record<string, unknown>`，涉及 registry.ts、agent.ts、subagent.ts、todo.ts、skills.ts、compressor.ts 六个文件。工具实现用 `String()`/`Number()` 做类型转换，todo 的 `args[“tasks”]` 不再需要 `as unknown as` 断言。167 个测试全部通过。
**收益**：类型签名与 LLM 实际返回的 JSON 类型一致，消除运行时类型断言。

---

## ~~P1：建议下一阶段做（扩展前先清结构）~~ ✅ 全部完成

### ~~P1-1. 抽离 CLI / REPL 层~~ ✅ 已完成
**完成时间**：2026-04-27
**改动**：新建 `src/repl.ts`（REPL 交互层）和 `src/cli-commands.ts`（CLI 命令注册与分发），`index.ts` 回归纯组装根。`index.ts` 从 255 行降至 120 行。`/skill` 命令通过命令注册表分发，未来添加新命令只需 register()。

### ~~P1-2. 重新整理压缩器接口~~ ✅ 已完成
**完成时间**：2026-04-27
**改动**：`compressToolResult()` 新增 `toolName` 参数，内部根据 `compressibleTools` 配置列表（默认 `[“run_bash”]`）决策是否压缩。`agent.ts` 的 `if (fnName === “run_bash”)` 硬编码删除，改为对所有工具统一调用 `compressToolResult()`。新增 1 个测试验证非压缩工具直接通过。167 个测试全部通过。
**收益**：新增大输出工具时只需修改配置，不需要改 agent 代码。

### ~~P1-3. 明确 Skill 是”静态加载”还是”热更新”~~ ✅ 已完成（路线 A：收紧语义）
**完成时间**：2026-04-27
**改动**：在 `skills.ts` 和 `cli-commands.ts` 注释中明确说明”静态快照语义”：skill 列表只在启动时加载一次，`/skill load` 只更新本地缓存。`/skill load` 提示文案更新为明确的说明。

---

## P2：可以后做（不是当前主阻塞）

### P2-1. 拆 `skills.ts`
### P2-2. 拆 `todo.ts` 的 domain / presentation
### P2-3. 统一日志事件结构

其中日志也值得一提：目前 logger 可用，但日志更像“调试输出”，不是“结构化事件”。如果以后要做 trace、性能统计、可视化 replay，这块还会继续演进。

---

## 四、一个比较稳妥的重构顺序

为了避免“边重构边失控”，建议按下面顺序推进：

### ~~第 1 步：先做不改变外部行为的小重构~~ ✅ 已完成（2026-04-27）
- ~~给 `agent.ts` 提取内部辅助函数~~ ✅ 已完成
- ~~给 registry / tool executor 调整参数类型~~ ✅ 已完成（对应 P0-3）

### ~~第 2 步：再动消息存储模型~~ ✅ 已完成（2026-04-27）
- ~~设计 `StoredMessage` 或 `ConversationEntry`~~ → 采用了 `HistoryEntry` 方案
- ~~让 round / summary / system prompt 元信息进入统一存储~~ → round 已收归 history
- ~~适配 normalize / block grouping / compressor~~ → 下游模块无需修改

### ~~第 3 步：最后拆 CLI 和动态组件边界~~ ✅ 已完成（2026-04-27）
- ~~拆 `index.ts`~~ → 新建 repl.ts + cli-commands.ts
- ~~明确 skill reload 语义~~ → 采用路线 A（静态快照）
- 判断是否需要支持动态 tool definition → 当前不需要（教学项目）

这个顺序的好处是：

- 每一步都能独立通过测试
- 不会一下子动到全项目主干
- 对教学项目来说，读者也更容易跟着理解“为什么这样演进”

---

## 五、如果只允许改三件事，我建议改什么

如果时间有限，只做三项，我建议是：

1. ~~**把 `agent.ts` 拆成几个内部步骤函数**~~ ✅ 已完成（2026-04-27）
2. ~~**把消息元信息收回到统一存储，不再依赖平行数组**~~ ✅ 已完成（2026-04-27）
3. ~~**把工具参数类型从 `Record<string, string>` 升级掉**~~ ✅ 已完成（2026-04-27）

这三项做完，后面无论要加 streaming、更多 tools、更多 provider，还是更复杂的上下文压缩，基础都会稳很多。

---

## 六、最后一句判断

这个项目目前**不是“设计错了”**，而是已经走到了一个典型拐点：

- 第一阶段，重点是“把能力做出来、讲明白”。
- 下一阶段，重点应该转向“把关键边界收紧，让后续功能不再继续堆到主循环里”。

所以建议后续重构原则是：

**不追求抽象更高级，只追求边界更清楚、状态更集中、接口更可信。**
