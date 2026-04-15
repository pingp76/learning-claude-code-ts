# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A teaching-purpose coding agent built in TypeScript. The goal is to demonstrate how a coding agent (like Claude Code) works internally — with clear, well-documented code that prioritizes readability over production complexity.

Design documents live in `doc/`.

**重要：** 这是一个系列递进的教学项目。每次编写新功能模块时，必须先读取 `doc/summary.md` 了解当前项目状态。每次完成代码后，按需更新 `doc/summary.md`。

## Commands

```bash
npm run build          # Compile TS → dist/
npm run dev            # Run with tsx watch (hot reload)
npm test               # Run tests once (vitest)
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
npm run typecheck      # Type-check without emitting
npm run lint           # Lint with eslint
npm run format         # Format with prettier
npm run format:check   # Check formatting without writing
```

Run a single test file: `npx vitest run src/path/to/file.test.ts`

## TypeScript Configuration

- **ESM only** (`"type": "module"` in package.json, `module: "NodeNext"`)
- **Strict mode** enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Import `.js` extensions in imports (NodeNext requirement): `import { foo } from "./foo.js"`
- Path alias: `@/*` maps to `src/*`
- Target: ES2022 / Node >= 20

## Architecture

Source code is in `src/`. Key modules (to be built):

- **Agent loop** (`agent.ts`) — orchestrates the think → act → observe cycle
- **Tools** (`tools/`) — bash shell execution with dangerous command filtering
- **LLM client** (`llm.ts`) — OpenAI SDK 封装，通过自定义 baseURL 接入 MiniMax API
- **Message/history** (`history.ts`) — manages conversation context
- **Config** (`config.ts`) — 从 .env 加载配置
- **Logger** (`logger.ts`) — 可调级别的日志工具

## Conventions

- All source in `src/`, tests co-located as `*.test.ts`
- Use named exports; avoid default exports
- Use `interface` for object shapes, `type` for unions/intersections
- Prefer `async/await` over raw promises
- **所有生成或修改的代码必须包含详细的中文注释**，解释每段逻辑的目的和原理，便于学习理解

## Coding Guidelines (Karpathy)

Behavioral guidelines derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls. These bias toward caution over speed — for trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a plan with verification at each step.
