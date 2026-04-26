/**
 * config.ts — 配置加载模块
 *
 * 职责：从 .env 文件中读取环境变量，组装成类型安全的配置对象。
 * 这样做的目的是将敏感信息（如 API Key）与代码分离，
 * 不同环境（开发/测试/生产）可以使用不同的 .env 文件。
 *
 * 依赖：dotenv 库，它会在 import 时自动将 .env 文件中的变量注入到 process.env 中。
 */

// dotenv/config 是 dotenv 的副作用导入，不需要使用它的返回值
// 它的作用是：在 import 执行时，自动读取项目根目录的 .env 文件，
// 把里面的键值对设置到 process.env 中
import "dotenv/config";

/**
 * Config — 应用配置的类型定义
 *
 * 通过 interface 定义配置的形状，TypeScript 会在编译时检查
 * 所有使用配置的地方是否正确访问了这些字段。
 */
interface Config {
  /** LLM API 的认证密钥，用于验证调用者身份 */
  apiKey: string;
  /** LLM API 的基础 URL，MiniMax 使用 OpenAI 兼容格式 */
  baseURL: string;
  /** 要调用的模型名称，如 "MiniMax-M2.5" */
  model: string;
  /** 日志级别：debug < info < warn < error */
  logLevel: string;
  /** 上下文压缩配置 */
  compression: CompressionConfig;
}

/**
 * CompressionConfig — 压缩相关配置项
 *
 * 所有项都有默认值，通过环境变量覆盖。
 */
export interface CompressionConfig {
  /** 即时压缩的 token 阈值（超过此值存文件） */
  thresholdToolOutput: number;
  /** 衰减压缩的轮次阈值（超过此轮数的工具结果会被截断） */
  decayThreshold: number;
  /** 衰减后保留的 token 数 */
  decayPreviewTokens: number;
  /** 触发全量压缩的 token 阈值 */
  maxContextTokens: number;
  /** 全量压缩时保留的最近消息块数 */
  compactKeepRecent: number;
}

/**
 * getEnv — 获取必需的环境变量
 *
 * 这是一个辅助函数，封装了 "读取环境变量 + 缺失时报错" 的逻辑。
 * 使用泛型约束确保返回值一定是 string 类型（不会是 undefined）。
 *
 * @param key - 环境变量的名称
 * @returns 环境变量的值
 * @throws 如果环境变量不存在，抛出明确的错误信息
 */
function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    // 抛出错误而不是返回 undefined，可以尽早发现问题
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * loadConfig — 加载并返回应用配置
 *
 * 把分散的环境变量集中到一个类型安全的对象中，
 * 后续代码只需要依赖这个 Config 对象，不需要直接访问 process.env。
 *
 * LOG_LEVEL 是可选的，默认为 "info"。
 */
export function loadConfig(): Config {
  return {
    apiKey: getEnv("LLM_API_KEY"),
    baseURL: getEnv("LLM_BASE_URL"),
    model: getEnv("LLM_MODEL"),
    // ?? 是空值合并运算符：只有当左边是 null 或 undefined 时才使用右边的默认值
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    compression: {
      thresholdToolOutput: Number(process.env["COMPRESS_TOOL_OUTPUT"]) || 2000,
      decayThreshold: Number(process.env["COMPRESS_DECAY_THRESHOLD"]) || 3,
      decayPreviewTokens: Number(process.env["COMPRESS_DECAY_PREVIEW"]) || 100,
      maxContextTokens: Number(process.env["COMPRESS_MAX_CONTEXT"]) || 80000,
      compactKeepRecent: Number(process.env["COMPACT_KEEP_RECENT"]) || 4,
    },
  };
}
