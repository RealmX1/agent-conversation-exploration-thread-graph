// Claude Code transcript → 已完成 turn 序列（handoff A.6）。
//
// 增量：按字节偏移只读新追加的部分，偏移只推进到完整换行；文件变小则整份重算。
// 签名 `${mtimeMs}:${size}:${offset}`——它同时是漏斗签名对账的键，所以必须能感知任何追加。
//
// 本模块**不数自己的 turn**以外的东西：turn 编号就是人类输入边界的序号，从 1 起单调，
// 这是本包 turn 编号的权威来源（AGENTS.md 铁律）。

import type {
	CompletedConversationTurn,
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	ConversationSessionRef,
	ConversationUserMessageOrigin,
} from "../core/index.js";
import { COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH } from "../core/index.js";
import {
	DEFAULT_MAX_INCREMENTAL_READ_BYTES,
	parseTranscriptJsonRecord,
	readAppendedCompleteJsonLines,
} from "./bounded-json-lines-reader.js";
import {
	classifyClaudeCodeTranscriptRecord,
	countAssistantToolUseBlocks,
	readAssistantMessageText,
	readTranscriptRecordTimestamp,
	readUserMessageText,
} from "./claude-code-transcript-record-classifier.js";

function truncateExcerpt(text: string): string {
	const collapsed = text.trim();
	return collapsed.length <= COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH
		? collapsed
		: collapsed.slice(0, COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH);
}

/** 累积中的 turn；`endedAt` 在下一条边界到来（或读到末尾）时才定稿。 */
interface AccumulatingTurn {
	turnNumber: number;
	userPromptExcerpt: string;
	assistantResponseExcerpt: string;
	startedAt: string;
	lastRecordTimestamp: string;
	userMessageOrigin: ConversationUserMessageOrigin;
	toolCallCount: number;
}

interface TranscriptProjectionState {
	byteOffset: number;
	accumulatedTurns: AccumulatingTurn[];
}

export interface ClaudeCodeTranscriptCompletedTurnSourceOptions {
	/**
	 * 末 turn 是否算已完成。
	 *
	 * transcript 里看不出「agent 说完了没有」——只有下一条用户消息才能证明上一个 turn 收口。
	 * 宿主在 **Stop 边沿**触发作业时，末 turn 事实上已经结束，此时传 true；
	 * 其余场景（轮询、手动 CLI）保持 false，末 turn 进 `inProgressTurnNumber` 不参与判定。
	 */
	treatFinalTurnAsCompleted?: boolean;
	maxIncrementalReadBytes?: number;
}

export class ClaudeCodeTranscriptCompletedTurnSource implements CompletedTurnSequenceSource {
	// 按 transcript 路径缓存增量状态：同一个 exploration 每 turn 都会来读一次，
	// 每次从头解析 100MB 是不可接受的。
	private readonly projectionStateByTranscriptPath = new Map<string, TranscriptProjectionState>();
	private readonly treatFinalTurnAsCompleted: boolean;
	private readonly maxIncrementalReadBytes: number;

	constructor(options: ClaudeCodeTranscriptCompletedTurnSourceOptions = {}) {
		this.treatFinalTurnAsCompleted = options.treatFinalTurnAsCompleted ?? false;
		this.maxIncrementalReadBytes = options.maxIncrementalReadBytes ?? DEFAULT_MAX_INCREMENTAL_READ_BYTES;
	}

	async readCompletedTurnSequence(sessionRef: ConversationSessionRef): Promise<CompletedTurnSequenceSnapshot> {
		if (sessionRef.harnessKind !== "claude_code") {
			throw new Error(
				`ClaudeCodeTranscriptCompletedTurnSource 只处理 claude_code 会话，收到 ${sessionRef.harnessKind}`,
			);
		}
		const { transcriptPath, nativeSessionId } = sessionRef;
		const previousState = this.projectionStateByTranscriptPath.get(transcriptPath) ?? {
			byteOffset: 0,
			accumulatedTurns: [],
		};

		let readResult: Awaited<ReturnType<typeof readAppendedCompleteJsonLines>>;
		try {
			readResult = await readAppendedCompleteJsonLines(
				transcriptPath,
				previousState.byteOffset,
				this.maxIncrementalReadBytes,
			);
		} catch {
			// transcript 读不到（尚未创建 / 被删）：回一份空快照而不是抛——
			// 宿主的图应当降级成「暂不可用」，不该因为一次读失败就炸掉整条触发链。
			return {
				conversationSessionId: nativeSessionId,
				sourceKind: "claude_code_transcript",
				turns: [],
				sourceSignature: "unavailable",
				projectionConfidence: "transcript_reconstructed",
				inProgressTurnNumber: null,
			};
		}

		const accumulatedTurns = readResult.fileWasTruncated ? [] : [...previousState.accumulatedTurns];
		for (const line of readResult.completeLines) {
			const record = parseTranscriptJsonRecord(line);
			if (record === null) continue;
			const recordRole = classifyClaudeCodeTranscriptRecord(record);
			const recordTimestamp = readTranscriptRecordTimestamp(record);
			const currentTurn = accumulatedTurns[accumulatedTurns.length - 1];

			if (recordRole === "human_typed_turn_boundary") {
				const startedAt = recordTimestamp ?? currentTurn?.lastRecordTimestamp ?? new Date(0).toISOString();
				accumulatedTurns.push({
					turnNumber: accumulatedTurns.length + 1,
					userPromptExcerpt: truncateExcerpt(readUserMessageText(record)),
					assistantResponseExcerpt: "",
					startedAt,
					lastRecordTimestamp: startedAt,
					userMessageOrigin: "human_typed",
					toolCallCount: 0,
				});
				continue;
			}
			if (currentTurn === undefined) {
				// 首个人类边界之前的记录（会话恢复旁白、系统提示等）不属于任何 turn。
				continue;
			}
			if (recordTimestamp !== null) currentTurn.lastRecordTimestamp = recordTimestamp;
			if (recordRole === "assistant_message") {
				const assistantText = readAssistantMessageText(record);
				// 只留**最后一段** text：它才是这一 turn 的结论，中间的过程叙述不进摘录。
				if (assistantText.trim() !== "") currentTurn.assistantResponseExcerpt = truncateExcerpt(assistantText);
				currentTurn.toolCallCount += countAssistantToolUseBlocks(record);
			}
		}

		this.projectionStateByTranscriptPath.set(transcriptPath, {
			byteOffset: readResult.nextByteOffset,
			accumulatedTurns,
		});

		const finalTurnIsInProgress = accumulatedTurns.length > 0 && !this.treatFinalTurnAsCompleted;
		const completedTurns = finalTurnIsInProgress ? accumulatedTurns.slice(0, -1) : accumulatedTurns;
		const lastAccumulatedTurn = accumulatedTurns[accumulatedTurns.length - 1];

		return {
			conversationSessionId: nativeSessionId,
			sourceKind: "claude_code_transcript",
			turns: completedTurns.map(
				(turn): CompletedConversationTurn => ({
					turnNumber: turn.turnNumber,
					userPromptExcerpt: turn.userPromptExcerpt,
					assistantResponseExcerpt: turn.assistantResponseExcerpt,
					startedAt: turn.startedAt,
					endedAt: turn.lastRecordTimestamp,
					userMessageOrigin: turn.userMessageOrigin,
					toolCallCount: turn.toolCallCount,
				}),
			),
			sourceSignature: `${readResult.fileModifiedAtMilliseconds}:${readResult.fileSizeBytes}:${readResult.nextByteOffset}`,
			projectionConfidence: "transcript_reconstructed",
			inProgressTurnNumber: finalTurnIsInProgress ? (lastAccumulatedTurn?.turnNumber ?? null) : null,
		};
	}

	/** 丢弃某个 transcript 的增量状态，下次从头重算（测试与 CLI 的 `doctor` 用）。 */
	forgetTranscriptProjectionState(transcriptPath: string): void {
		this.projectionStateByTranscriptPath.delete(transcriptPath);
	}
}
