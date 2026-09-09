// dsh 那一侧 seam 的**结构性**最小契约（handoff A.8）。
//
// 为什么在这里重新声明而不是 import `@deepseek-ai/*`：
//   1. 依赖方向——`/core` 必须零宿主依赖，dsh 包只能是 `/dsh-plugin` 的 peerDependency；
//   2. dsh 处于 developer preview 并明示破坏性变更，本包钉死一份**只用到的最小形状**，
//      dsh 改名时只有这一个文件要动，且 tsc 会立刻指出来，而不是让 smoke 静默腐烂。
// 这些接口按 dsh `docs/subsystems/{session,subagent,session-projection}.md` 的公开签名写成，
// 真接线时由 `apply(ctx)` 的调用点做结构性适配。

/** dsh 会话日志事件（本包只关心 turn 边界、用户消息与助手消息三类）。 */
export type DshSessionEvent =
	| { type: "turn/start"; seq: number; timestamp?: string; data: { turn: number } }
	| { type: "turn/end"; seq: number; timestamp?: string; data: { turn: number; reason?: string } }
	| {
			type: "user/message";
			seq: number;
			timestamp?: string;
			data: { turn?: number; source?: string; content?: unknown };
	  }
	| {
			type: "assistant/message";
			seq: number;
			timestamp?: string;
			data: { turn: number; step: number; message?: { content?: unknown } };
	  }
	| { type: "tool/call"; seq: number; timestamp?: string; data: { turn: number; step: number } }
	| { type: string; seq: number; timestamp?: string; data?: unknown };

/** `ctx.subagents.start({ provider: "fork", … })` 的最小形状（镜像 SubagentResult）。 */
export interface DshSubagentRegistry {
	start(request: {
		provider: string;
		parent: string;
		prompt: string;
		outputSchema: unknown;
		signal?: AbortSignal;
	}): Promise<{
		structured?: unknown;
		output?: unknown;
		stopReason: string;
		usage?: { inputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number };
		id?: string;
	}>;
}

/** `ctx.sessionProjections.register(definition)` 的最小形状。 */
export interface DshSessionProjectionRegistry {
	register<State>(definition: {
		key: string;
		init: State;
		stateVersion: number;
		apply(state: State, event: DshSessionEvent): State;
		view(state: State): unknown;
	}): () => void;
}

/** Cordis 插件拿到的 ctx（只声明本插件注入的三项）。 */
export interface DshPluginContext {
	subagents?: DshSubagentRegistry;
	sessionProjections?: DshSessionProjectionRegistry;
	inject?: (dependencies: string[], callback: (injectedContext: DshPluginContext) => void) => void;
}
