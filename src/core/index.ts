// 子路径入口 `agent-conversation-exploration-thread-graph/core`。
// 零宿主依赖：领域 schema（zod）/ store / apply 漏斗 / 维护作业 / projection view / lane 布局。
// R0 阶段只导出契约常量；R1 起按 `.plan/docs/exploration-thread-graph-core-handoff.md` A.2 布局逐文件补齐。

/** collection / topic-registry 文件的 schema 版本；改 schema 必 bump 并在 CHANGELOG 记（契约 A.13-4）。 */
export const EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION = 1 as const;

/**
 * 维护作业 fork 进程的环境变量名（契约 A.13-3）。
 * 宿主（cline-kanban 的 `kanban hooks`）据此整体短路事件摄入并对 PreToolUse 回 deny；无宿主时无害。
 */
export const AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME =
	"AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB" as const;
