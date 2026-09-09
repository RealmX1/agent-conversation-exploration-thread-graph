// dsh 会话日志 → 已完成 turn 序列（handoff A.8 的 ③）。
//
// 与 Claude Code 那一侧的根本差别：dsh **自带 turn 边界事件**，编号是免费的、权威的，
// 不需要从消息流里重建——所以这里的 projectionConfidence 是 `authoritative`。
// 「进行中的末 turn」也有确切定义：有 `turn/start` 但还没有配对的 `turn/end`。

import type {
	CompletedConversationTurn,
	CompletedTurnSequenceSnapshot,
	ConversationUserMessageOrigin,
} from "../core/index.js";
import { COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH } from "../core/index.js";
import type { DshSessionEvent } from "./dsh-session-seam-contracts.js";

/**
 * `user/message.source` 里表示「harness 注入」的取值前缀。
 *
 * ⚠️ dsh 处于 developer preview，其 source 词表尚未在公开文档里定死（本地 clone 也查不到枚举）。
 * 这里按文档正文点名的三类注入（`agent.inject()` 的合成上下文、skill 内容、cron 通知）取保守前缀匹配，
 * **认不出来就按人类输入处理**——宁可多开一个 turn 让人看见，也不要静默吞掉一次真实提问。
 * dsh 词表定稿后，改这一个常量即可。
 *
 * 匹配语义是 `startsWith` 而**不是**子串包含：子串比前缀宽松，会把 `noninject`、`user-skill-request`
 * 这类人类来源判成注入，方向与上面的安全偏向正好相反。宁可漏认一个新出现的注入来源（退化成人类输入、
 * 至多多留一个 turn 的摘录），也不要把真实提问归到注入里。
 */
export const DSH_HARNESS_INJECTED_USER_MESSAGE_SOURCE_PREFIXES = [
	"inject",
	"agent-inject",
	"agent.inject",
	"skill",
	"cron",
	"notice",
	"continuation",
];

export function classifyDshUserMessageOrigin(source: string | undefined): ConversationUserMessageOrigin {
	if (source === undefined) return "human_typed";
	const normalizedSource = source.toLowerCase();
	return DSH_HARNESS_INJECTED_USER_MESSAGE_SOURCE_PREFIXES.some((injectedSourcePrefix) =>
		normalizedSource.startsWith(injectedSourcePrefix),
	)
		? "harness_injected"
		: "human_typed";
}

/** dsh 的 content 可能是字符串，也可能是 ContentBlock[]；只取 text 部分。 */
export function readDshMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function truncateExcerpt(text: string): string {
	const collapsed = text.trim();
	return collapsed.length <= COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH
		? collapsed
		: collapsed.slice(0, COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH);
}

interface FoldingTurn {
	turnNumber: number;
	userPromptExcerpt: string;
	assistantResponseExcerpt: string;
	startedAt: string;
	endedAt: string | null;
	userMessageOrigin: ConversationUserMessageOrigin;
	toolCallCount: number;
}

/** projection 单元的折叠状态（dsh 宿主纯 fold，客户端收整值）。 */
export interface DshCompletedTurnFoldState {
	turnsByNumber: Record<number, FoldingTurn>;
	openTurnNumber: number | null;
	highestSeq: number;
}

export const DSH_COMPLETED_TURN_FOLD_INITIAL_STATE: DshCompletedTurnFoldState = {
	turnsByNumber: {},
	openTurnNumber: null,
	highestSeq: 0,
};

/** 纯 fold：一条事件推进一次状态。dsh 的 ProjectionDefinition.apply 直接用它。 */
export function foldDshSessionEventIntoCompletedTurns(
	state: DshCompletedTurnFoldState,
	event: DshSessionEvent,
): DshCompletedTurnFoldState {
	const eventTimestamp = event.timestamp ?? new Date(0).toISOString();
	if (event.type === "turn/start") {
		const { turn } = (event as Extract<DshSessionEvent, { type: "turn/start" }>).data;
		return {
			turnsByNumber: {
				...state.turnsByNumber,
				[turn]: {
					turnNumber: turn,
					userPromptExcerpt: "",
					assistantResponseExcerpt: "",
					startedAt: eventTimestamp,
					endedAt: null,
					userMessageOrigin: "human_typed",
					toolCallCount: 0,
				},
			},
			openTurnNumber: turn,
			highestSeq: event.seq,
		};
	}
	if (event.type === "turn/end") {
		const { turn } = (event as Extract<DshSessionEvent, { type: "turn/end" }>).data;
		const existing = state.turnsByNumber[turn];
		if (existing === undefined) return { ...state, highestSeq: event.seq };
		return {
			turnsByNumber: { ...state.turnsByNumber, [turn]: { ...existing, endedAt: eventTimestamp } },
			openTurnNumber: state.openTurnNumber === turn ? null : state.openTurnNumber,
			highestSeq: event.seq,
		};
	}
	if (event.type === "user/message") {
		const { turn, source, content } = (event as Extract<DshSessionEvent, { type: "user/message" }>).data;
		const targetTurnNumber = turn ?? state.openTurnNumber;
		const existing = targetTurnNumber === null ? undefined : state.turnsByNumber[targetTurnNumber];
		if (existing === undefined || targetTurnNumber === null) return { ...state, highestSeq: event.seq };
		const origin = classifyDshUserMessageOrigin(source);
		// 一个 turn 里可能有多条 user/message（注入的上下文 + 真正的提问）；
		// 摘录只认第一条人类输入，注入类不覆盖它。
		const shouldTakeExcerpt =
			existing.userPromptExcerpt === "" ||
			(origin === "human_typed" && existing.userMessageOrigin === "harness_injected");
		return {
			turnsByNumber: {
				...state.turnsByNumber,
				[targetTurnNumber]: shouldTakeExcerpt
					? {
							...existing,
							userPromptExcerpt: truncateExcerpt(readDshMessageText(content)),
							userMessageOrigin: origin,
						}
					: existing,
			},
			openTurnNumber: state.openTurnNumber,
			highestSeq: event.seq,
		};
	}
	if (event.type === "assistant/message") {
		const { turn, message } = (event as Extract<DshSessionEvent, { type: "assistant/message" }>).data;
		const existing = state.turnsByNumber[turn];
		if (existing === undefined) return { ...state, highestSeq: event.seq };
		const assistantText = readDshMessageText(message?.content);
		return {
			turnsByNumber: {
				...state.turnsByNumber,
				// 只留最后一段：与 Claude Code 侧同一规则，turn 的结论在最后。
				[turn]:
					assistantText.trim() === ""
						? existing
						: { ...existing, assistantResponseExcerpt: truncateExcerpt(assistantText) },
			},
			openTurnNumber: state.openTurnNumber,
			highestSeq: event.seq,
		};
	}
	if (event.type === "tool/call") {
		const { turn } = (event as Extract<DshSessionEvent, { type: "tool/call" }>).data;
		const existing = state.turnsByNumber[turn];
		if (existing === undefined) return { ...state, highestSeq: event.seq };
		return {
			turnsByNumber: { ...state.turnsByNumber, [turn]: { ...existing, toolCallCount: existing.toolCallCount + 1 } },
			openTurnNumber: state.openTurnNumber,
			highestSeq: event.seq,
		};
	}
	return { ...state, highestSeq: event.seq };
}

/** fold 状态 → 本包的快照整值。签名用 `highestSeq`：dsh 的 seq 单调且连续，比 mtime 可靠得多。 */
export function buildCompletedTurnSequenceSnapshotFromDshFoldState(
	conversationSessionId: string,
	state: DshCompletedTurnFoldState,
): CompletedTurnSequenceSnapshot {
	const completedTurns: CompletedConversationTurn[] = Object.values(state.turnsByNumber)
		.filter((turn) => turn.endedAt !== null)
		.sort((left, right) => left.turnNumber - right.turnNumber)
		.map((turn) => ({
			turnNumber: turn.turnNumber,
			userPromptExcerpt: turn.userPromptExcerpt,
			assistantResponseExcerpt: turn.assistantResponseExcerpt,
			startedAt: turn.startedAt,
			endedAt: turn.endedAt ?? turn.startedAt,
			userMessageOrigin: turn.userMessageOrigin,
			toolCallCount: turn.toolCallCount,
		}));
	return {
		conversationSessionId,
		sourceKind: "dsh_session_log",
		turns: completedTurns,
		sourceSignature: `dsh-seq:${state.highestSeq}`,
		// dsh 自带 turn 边界事件，编号不是重建出来的。
		projectionConfidence: "authoritative",
		inProgressTurnNumber: state.openTurnNumber,
	};
}
