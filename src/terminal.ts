/**
 * terminal.ts — 终端输入输出封装
 *
 * 职责：统一管理 readline 接口，供 REPL 和权限确认共享同一个 stdin。
 *
 * 为什么需要？
 * - REPL 需要读取用户输入（question）
 * - 权限确认也需要读取用户输入（askUser）
 * - 如果各自创建 readline.Interface，会抢占同一个 stdin
 * - 统一封装后，只有一个 readline 实例，两个功能互不干扰
 */

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * Terminal — 终端接口
 */
export interface Terminal {
  /** 向用户提问，返回用户输入（用于 REPL） */
  question(prompt: string): Promise<string>;
  /** 询问用户确认权限，返回 true/false */
  askUser(message: string): Promise<boolean>;
  /** 关闭 readline 接口 */
  close(): void;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createTerminal — 创建终端实例
 *
 * 内部只创建一个 readline.Interface，question() 和 askUser() 共享它。
 */
export function createTerminal(): Terminal {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    question(prompt: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
          resolve(answer);
        });
      });
    },

    askUser(message: string): Promise<boolean> {
      return new Promise((resolve) => {
        rl.question(`Allow tool call? ${message} [y/N] `, (answer) => {
          const normalized = answer.trim().toLowerCase();
          resolve(normalized === "y" || normalized === "yes");
        });
      });
    },

    close(): void {
      rl.close();
    },
  };
}
