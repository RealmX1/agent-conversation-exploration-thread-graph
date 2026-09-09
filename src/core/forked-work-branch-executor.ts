// fork 执行器的接口与类型（handoff A.3），形状镜像 dsh 的
// SubagentStartRequest.outputSchema → SubagentResult.structured。
//
// 语义：以父会话已完成的 turn 前缀为种子起一个分身，要求它只输出满足 outputSchema 的结构化结果。
// 分身**不写宿主任何文件**，只回报结果；落盘一律由 apply 漏斗执行（契约 A.13-3）。

import type { ConversationSessionRef } from "./completed-turn-sequence-source.js";

/**
 * object 为根的 JSON Schema。刻意不引第三方 JSON Schema 类型包：
 * 这里只需要「是个 JSON 对象、根类型是 object」这一点约束，其余交给各 harness 的校验。
 */
export interface ObjectRootedJsonSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
	[additionalKeyword: string]: unknown;
}

export interface ForkedWorkBranchRequest {
	parentSession: ConversationSessionRef;
	promptText: string;
	outputSchema: ObjectRootedJsonSchema;
	timeoutMs: number;
	signal?: AbortSignal;
}

export type ForkedWorkBranchStopReason = "completed" | "error" | "timeout" | "cancelled";

/** 用量回报。cacheReadInputTokens 是契约 A.13-3 明确要求回报的字段。 */
export interface ForkedWorkBranchUsage {
	inputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

export interface ForkedWorkBranchResult {
	/** 满足 outputSchema 时存在；不满足或解析失败时缺席，由调用方按 rejected 处理。 */
	structured?: unknown;
	outputText: string;
	stopReason: ForkedWorkBranchStopReason;
	usage?: ForkedWorkBranchUsage;
	/** 分身自己的原生 session id，仅供审计；本包不删它的 jsonl。 */
	forkedNativeSessionId?: string;
}

export interface ForkedWorkBranchExecutor {
	start(request: ForkedWorkBranchRequest): Promise<ForkedWorkBranchResult>;
}

/**
 * 维护作业 fork 进程的环境变量名（契约 A.13-3）。
 * 宿主（cline-kanban 的 `kanban hooks`）据此整体短路事件摄入并对 PreToolUse 回 deny；无宿主时无害。
 */
export const AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME =
	"AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB";

/**
 * 宿主 Claude Code 进程注入、**必须**从分身 env 里洗掉的变量名。
 *
 * 实测：继承 `CLAUDE_CODE_CHILD_SESSION=1` 会让分身**完全不落盘 transcript**
 * （终端告警 "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"），
 * `forkedNativeSessionId` 的审计价值随之归零；其余几个会让分身误认为自己是宿主会话的一部分。
 * 作业往往由宿主会话内的 hook 触发，这些变量一定在 env 里，所以洗掉是**必需**而非防御性编程。
 */
export const INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES = [
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"CLAUDECODE",
] as const;
