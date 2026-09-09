// 子路径入口 `agent-conversation-exploration-thread-graph/harness-codex`。
// Codex harness 适配器（R3 可选）：rollout JSONL 投影 + `codex exec resume` 执行器。
// 先核实 `codex exec resume` 是否写回同一 rollout（污染主会话）再决定执行器形态，见 handoff A.6。

/** `ConversationSessionRef.harnessKind` 判别值。 */
export const CODEX_HARNESS_KIND = "codex" as const;
