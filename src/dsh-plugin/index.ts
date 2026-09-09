// 子路径入口 `agent-conversation-exploration-thread-graph/dsh-plugin`。
// DeepSeek Harness（dsh）Cordis 插件 smoke 适配（handoff A.8）：只验证边界，不做 UI。
//
// 边界一共三处，全部在这里对上：
//   ① ForkedWorkBranchExecutor ← `ctx.subagents.start({ provider: "fork", outputSchema })`
//   ② CompletedTurnSequenceSource ← 会话日志 `turn/start|end` + `user/message` 的纯 fold
//   ③ projection ← `ctx.sessionProjections.register({ key: "explorationThreadGraph", … })`
//
// 依赖纪律：**不引入 `@deepseek-ai/*`**。dsh 是 developer preview 且明示破坏性变更，
// 本包只钉一份用得到的最小结构性契约（dsh-session-seam-contracts.ts），
// 真接线时由宿主把 ctx 传进来做结构性适配。这样 dsh 漂移不会波及 `/core` 与 `/harness-claude-code`。

import type { CompletedTurnSequenceSnapshot } from "../core/index.js";
import {
	buildCompletedTurnSequenceSnapshotFromDshFoldState,
	DSH_COMPLETED_TURN_FOLD_INITIAL_STATE,
	type DshCompletedTurnFoldState,
	foldDshSessionEventIntoCompletedTurns,
} from "./dsh-session-log-completed-turn-source.js";
import type { DshPluginContext } from "./dsh-session-seam-contracts.js";

/** dsh session-projection 注册 key（handoff A.8）。 */
export const DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY = "explorationThreadGraph" as const;

/**
 * projection 的 stateVersion：fold 语义一变就要 bump，
 * 否则 dsh 会把旧的持久化 `(sessionId, key, ver, seq, val)` 当成还能用。
 */
export const DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_STATE_VERSION = 1;

export type { DshCompletedTurnFoldState } from "./dsh-session-log-completed-turn-source.js";
export {
	buildCompletedTurnSequenceSnapshotFromDshFoldState,
	classifyDshUserMessageOrigin,
	DSH_COMPLETED_TURN_FOLD_INITIAL_STATE,
	DSH_HARNESS_INJECTED_USER_MESSAGE_SOURCE_PREFIXES,
	foldDshSessionEventIntoCompletedTurns,
	readDshMessageText,
} from "./dsh-session-log-completed-turn-source.js";
export type {
	DshPluginContext,
	DshSessionEvent,
	DshSessionProjectionRegistry,
	DshSubagentRegistry,
} from "./dsh-session-seam-contracts.js";
export type { DshSubagentForkedWorkBranchExecutorOptions } from "./dsh-subagent-forked-work-branch-executor.js";
export { DshSubagentForkedWorkBranchExecutor } from "./dsh-subagent-forked-work-branch-executor.js";

/** projection 单元的 view 整值：turn 快照本身（图的落盘仍在本包文件 store，见 A.8 的 ⑤）。 */
export interface DshExplorationThreadGraphProjectionValue {
	completedTurnSequence: CompletedTurnSequenceSnapshot;
}

/**
 * Cordis 插件入口。dsh 侧以 `ctx.inject(['subagents','sessionProjections'], …)` 的形式加载，
 * 缺哪一项就跳过哪一项——headless 装配（没有 projection 注册表）不该因此起不来。
 */
export function apply(ctx: DshPluginContext): () => void {
	const disposers: (() => void)[] = [];

	if (ctx.sessionProjections !== undefined) {
		disposers.push(
			ctx.sessionProjections.register<DshCompletedTurnFoldState>({
				key: DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY,
				init: DSH_COMPLETED_TURN_FOLD_INITIAL_STATE,
				stateVersion: DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_STATE_VERSION,
				apply: foldDshSessionEventIntoCompletedTurns,
				view: (state): DshExplorationThreadGraphProjectionValue => ({
					// session id 由 dsh 在读取侧补齐；fold 状态本身不带它（同一份 fold 复用在任何会话上）。
					completedTurnSequence: buildCompletedTurnSequenceSnapshotFromDshFoldState("", state),
				}),
			}),
		);
	}

	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
