// 子路径入口 `agent-conversation-exploration-thread-graph/harness-claude-code`。
// Claude Code harness 适配器：transcript JSONL 已完成 turn 投影 + `claude -p --resume --fork-session` 执行器。

/** `ConversationSessionRef.harnessKind` 判别值。 */
export const CLAUDE_CODE_HARNESS_KIND = "claude_code" as const;

export type { BoundedJsonLinesReadResult } from "./bounded-json-lines-reader.js";
export {
	DEFAULT_MAX_INCREMENTAL_READ_BYTES,
	encodeClaudeCodeProjectDirectoryName,
	parseTranscriptJsonRecord,
	readAppendedCompleteJsonLines,
} from "./bounded-json-lines-reader.js";

export type { ClaudeCodeForkedSessionWorkBranchExecutorOptions } from "./claude-code-forked-session-work-branch-executor.js";
export { ClaudeCodeForkedSessionWorkBranchExecutor } from "./claude-code-forked-session-work-branch-executor.js";
export type { ClaudeCodeTranscriptCompletedTurnSourceOptions } from "./claude-code-transcript-completed-turn-source.js";
export { ClaudeCodeTranscriptCompletedTurnSource } from "./claude-code-transcript-completed-turn-source.js";
export type { ClaudeCodeTranscriptRecordRole } from "./claude-code-transcript-record-classifier.js";
export {
	classifyClaudeCodeTranscriptRecord,
	countAssistantToolUseBlocks,
	readAssistantMessageText,
	readTranscriptRecordTimestamp,
	readUserMessageText,
} from "./claude-code-transcript-record-classifier.js";
