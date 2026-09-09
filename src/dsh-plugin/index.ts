// 子路径入口 `agent-conversation-exploration-thread-graph/dsh-plugin`。
// DeepSeek Harness（dsh）Cordis 插件 smoke 适配（R4）：`export function apply(ctx)`，
// 用 `ctx.subagents.start({ provider: "fork", outputSchema })` 实现 ForkedWorkBranchExecutor，
// 从会话日志 `turn/start|end` 折出 CompletedTurnSequenceSource，并注册 `explorationThreadGraph` projection。
// R0 阶段不引入 `@deepseek-ai/*` peerDependency，只导出占位标识。

/** dsh session-projection 注册 key（handoff A.8）。 */
export const DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY = "explorationThreadGraph" as const;
