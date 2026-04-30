/**
 * hooks.ts — 轻量进程内 Hook 系统
 *
 * 职责：在 Agent 主流程的固定时机发出事件，让外部逻辑观察或干预主流程。
 *
 * 设计思想：
 * - Agent 主循环只负责两件事：(1) 在固定时机发出事件，附带当前上下文；
 *   (2) 根据 Hook 返回结果决定继续、阻止或补充上下文。
 * - Hook 负责外部扩展逻辑（如审计、提醒、注入提示），但不替代权限管理。
 * - 权限管理（permission.ts）仍然是安全边界，Hook 是扩展点。
 *
 * 本阶段限制：
 * - 不执行外部 shell hook 脚本
 * - 不读取配置文件
 * - 不做 Hook 并发执行
 * - 不做复杂优先级系统
 *
 * 三种事件：
 * - SessionStart：每个 Agent 实例第一次 run() 时触发
 * - PreToolUse：工具执行前（权限检查通过后）触发
 * - PostToolUse：工具执行后触发
 *
 * 三种返回语义：
 * - exitCode 0：继续当前动作
 * - exitCode 1：阻止当前动作（PreToolUse）/ 注入警告提醒（PostToolUse）
 * - exitCode 2：注入一条补充消息，然后继续
 *
 * 关键约束——延迟注入：
 * exitCode 2 的消息不能在工具执行前插入到 tool_call 和 tool_result 之间，
 * 否则会破坏 OpenAI API 的消息格式要求。因此所有待注入消息在当前 assistant
 * 的所有 tool_result 写完后，统一追加为 user 消息。
 */

import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * HookExitCode — Hook 返回的退出码
 *
 * - 0 (continue)：继续当前动作，不做额外处理
 * - 1 (block)：阻止当前动作（PreToolUse 会阻止工具执行）
 * - 2 (inject)：注入一条补充消息后继续
 */
export type HookExitCode = 0 | 1 | 2;

/**
 * HookResult — Hook 的返回结果
 *
 * exitCode 决定主流程如何响应：
 * - 0：什么都不做，继续
 * - 1：阻止动作（具体含义取决于事件类型）
 * - 2：将 message 作为补充消息注入对话历史
 */
export interface HookResult {
  /** 退出码：0=继续，1=阻止，2=注入补充消息后继续 */
  exitCode: HookExitCode;
  /** 补充说明文本，给用户、LLM 或日志看的 */
  message?: string;
}

/**
 * HookEventName — 支持的 Hook 事件名称
 */
export type HookEventName = "SessionStart" | "PreToolUse" | "PostToolUse";

/**
 * HookEvent — Hook 事件的联合类型（discriminated union）
 *
 * 每种事件携带不同的 payload，通过 name 字段区分类型。
 * 使用 discriminated union 可以让 handler 通过 event.name
 * 窄化到具体的 payload 类型。
 */
export type HookEvent =
  | {
      /** 会话开始事件 */
      name: "SessionStart";
      payload: {
        /** 用户输入的查询文本 */
        query: string;
      };
    }
  | {
      /** 工具执行前事件 */
      name: "PreToolUse";
      payload: {
        /** 工具调用的唯一 ID（对应 tool_call_id） */
        toolCallId: string;
        /** 工具名称（如 run_bash、run_read） */
        toolName: string;
        /** 已解析的工具参数（JSON.parse 后的对象） */
        args: Record<string, unknown>;
        /** 当前 Agent 主循环的轮次 */
        round: number;
      };
    }
  | {
      /** 工具执行后事件 */
      name: "PostToolUse";
      payload: {
        /** 工具调用的唯一 ID */
        toolCallId: string;
        /** 工具名称 */
        toolName: string;
        /** 已解析的工具参数 */
        args: Record<string, unknown>;
        /** 当前 Agent 主循环的轮次 */
        round: number;
        /** 工具执行的输出（经过 P1 即时压缩后的内容） */
        output: string;
        /** 工具执行是否出错 */
        error: boolean;
      };
    };

/**
 * HookHandler — Hook 处理函数的类型
 *
 * 接收一个 HookEvent，返回 HookResult（支持同步或异步）。
 * 泛型 T 允许 handler 声明自己只处理特定事件类型，
 * 但在 HookRunner 内部统一以 HookEvent 传入。
 */
export type HookHandler<T extends HookEvent = HookEvent> = (
  event: T,
) => Promise<HookResult> | HookResult;

/**
 * HookRunner — Hook 运行器的接口
 *
 * 只有一个 run() 方法：接收事件，执行所有已注册的 handler，返回聚合结果。
 */
export interface HookRunner {
  run(event: HookEvent): Promise<HookResult>;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createHookRunner — 创建 HookRunner 实例
 *
 * @param handlers - 按事件名注册的 handler 数组映射
 *   同一个事件可以注册多个 handler，按注册顺序串行执行。
 * @param logger - 日志器，用于记录 handler 异常
 * @returns HookRunner 实例
 *
 * 多个 handler 的聚合规则：
 * 1. 初始结果为 { exitCode: 0 }。
 * 2. handler 返回 0：继续执行下一个 handler。
 * 3. handler 返回 2：收集 message，继续执行下一个 handler。
 * 4. handler 返回 1：立即短路，返回 block。
 * 5. 多个 handler 返回 2 时，message 用空行拼接。
 *
 * 优先级：1（block）> 2（inject）> 0（continue）。
 *
 * handler 抛异常时只记录 warn 日志，然后继续执行后续 handler。
 * 原因：Hook 是扩展机制，不是安全机制；不能因为一个扩展逻辑异常
 * 就让 Agent 主流程不可用。
 */
export function createHookRunner(
  handlers: Partial<Record<HookEventName, HookHandler[]>>,
  logger: Logger,
): HookRunner {
  /**
   * run — 执行所有已注册的 handler 并聚合结果
   *
   * 串行执行，支持 block 短路和 inject 消息累积。
   */
  async function run(event: HookEvent): Promise<HookResult> {
    // noUncheckedIndexedAccess: 索引访问返回 T | undefined，需要 ?? []
    const list = handlers[event.name] ?? [];
    // 收集所有 exitCode 2 的 message
    const injected: string[] = [];

    for (const handler of list) {
      try {
        const result = await handler(event);

        // block 优先级最高：立即返回，不执行后续 handler
        if (result.exitCode === 1) {
          return result;
        }

        // inject：收集 message，继续执行后续 handler
        if (result.exitCode === 2 && result.message) {
          injected.push(result.message);
        }
      } catch (error) {
        // handler 异常：只记录 warn，不中断主流程
        logger.warn(
          "Hook %s failed: %s",
          event.name,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // 有收集到的 inject 消息，合并后返回
    if (injected.length > 0) {
      return { exitCode: 2, message: injected.join("\n\n") };
    }

    // 所有 handler 都返回 0 或没有 handler
    return { exitCode: 0 };
  }

  return { run };
}

/**
 * createNoopHookRunner — 创建空操作的 HookRunner
 *
 * 永远返回 { exitCode: 0 }，不做任何处理。
 * 用于没有传入 hookRunner 时的默认值，避免所有调用处
 * 都要做 `if (hookRunner)` 判断，保持主流程直线阅读。
 */
export function createNoopHookRunner(): HookRunner {
  return {
    async run() {
      return { exitCode: 0 };
    },
  };
}
