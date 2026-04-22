import { format } from "node:util";

/**
 * logger.ts — 日志模块
 *
 * 职责：提供统一的、可控制级别的日志输出。
 *
 * 为什么需要日志级别？
 * - 开发调试时，我们想看到所有细节（debug 级别）
 * - 正常运行时，只关心重要信息（info/warn/error）
 * - 通过一个开关（LOG_LEVEL）就能控制输出量，不需要删改代码
 *
 * 设计模式：工厂函数 + 闭包
 * - createLogger() 返回一个 Logger 对象，闭包捕获了 current（当前级别）
 * - 每次调用 logger.info() 等方法时，会比较消息级别与当前级别
 */

/**
 * LogLevel — 日志级别的联合类型
 *
 * 从低到高排列：debug < info < warn < error
 * 数字越大，级别越高，表示越严重
 */
type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * LEVEL_ORDER — 每个日志级别对应的数字优先级
 *
 * 日志过滤逻辑：只有当消息的级别 >= 当前配置的级别时，才会输出。
 * 例如配置 level="warn"，那么 debug(0) 和 info(1) 会被过滤掉，
 * 只输出 warn(2) 和 error(3)。
 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger — 日志器的接口定义
 *
 * 使用 interface 定义而不是直接返回对象，是为了：
 * 1. 类型更清晰，调用者知道有哪些方法
 * 2. 方便测试时可以 mock 这个接口
 * 3. 将来可以替换实现（如写入文件、发送到远程日志服务）
 */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * createLogger — 创建日志器
 *
 * @param level - 最低输出级别，低于此级别的日志会被静默忽略
 * @returns Logger 实例
 *
 * 工作原理：
 * 1. 将传入的 level 字符串转换为对应的数字优先级
 * 2. 内部的 log() 函数比较消息级别与当前级别，决定是否输出
 * 3. 输出格式：[ISO时间戳] [级别] 消息内容
 */
export function createLogger(level: string): Logger {
  // 将字符串级别转为数字，如果传入无效值则默认使用 info 级别
  const current =
    LEVEL_ORDER[(level as LogLevel) ?? "info"] ?? LEVEL_ORDER["info"];

  /**
   * log — 内部的通用日志输出函数
   *
   * @param lvl - 本次日志的级别
   * @param msg - 日志消息
   * @param args - 附加参数（如 %s 占位符的值）
   *
   * 根据级别选择不同的 console 方法：
   * - error → console.error（stderr，红色显示）
   * - warn  → console.warn（stderr，黄色显示）
   * - 其他  → console.log（stdout）
   */
  function log(lvl: LogLevel, msg: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[lvl] >= current) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${lvl.toUpperCase()}]`;
      // 使用 util.format 替换 %s/%d/%j 等占位符，再输出完整行
      const formatted = args.length > 0 ? format(msg, ...args) : msg;
      if (lvl === "error") {
        console.error(prefix, formatted);
      } else if (lvl === "warn") {
        console.warn(prefix, formatted);
      } else {
        console.log(prefix, formatted);
      }
    }
  }

  // 返回 Logger 接口的实现，每个方法绑定固定的日志级别
  return {
    debug: (msg, ...args) => log("debug", msg, ...args),
    info: (msg, ...args) => log("info", msg, ...args),
    warn: (msg, ...args) => log("warn", msg, ...args),
    error: (msg, ...args) => log("error", msg, ...args),
  };
}
