// 子路径入口 `agent-conversation-exploration-thread-graph/harness-claude-code`。
// Claude Code harness 适配器：transcript JSONL 已完成 turn 投影 + `claude -p --resume --fork-session` work-branch 执行器。
// R0 阶段只导出 harness 标识；R2 起按 handoff A.6 补齐。

/** `ConversationSessionRef.harnessKind` 判别值。 */
export const CLAUDE_CODE_HARNESS_KIND = "claude_code" as const;
