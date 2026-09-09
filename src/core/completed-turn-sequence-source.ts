// 「已完成 turn 序列」来源的接口与类型（handoff A.3），形状镜像 dsh 会话日志的 turn/start|end
// 与 user/message.source，好让同一份核心既能挂 Claude Code transcript，也能挂 dsh 会话日志。
//
// 铁律：turn 编号的权威在本接口的实现方，本包自己**不数 turn**、也不在任何文件里种 marker。

/** 宿主传入的会话引用；各 harness 带自己的字段，用 harnessKind 判别。 */
export type ConversationSessionRef =
	| {
			harnessKind: "claude_code";
			nativeSessionId: string;
			transcriptPath: string;
			workingDirectory: string;
			/**
			 * 会话**启动那一刻**的 argv 快照（不是触发时重算）。fork 执行器原样回传。
			 * `model` 是 argv 字面值（通常是浮动别名 `default`）；`appendSystemPrompt` 是逐字全文。
			 */
			launchArgvTemplate: {
				model: string;
				appendSystemPrompt: string | null;
				settingsPath: string | null;
				extraArgs: string[];
			};
			/** by-the-way 会话：它从父会话的哪个 turn 分叉出来。作业据此直接锚定，不再判定。 */
			forkedFromParentSessionTurnNumber?: number;
	  }
	| {
			harnessKind: "codex";
			nativeSessionId: string;
			rolloutPath: string;
			workingDirectory: string;
			forkedFromParentSessionTurnNumber?: number;
	  }
	| { harnessKind: "dsh"; nativeSessionId: string; forkedFromParentSessionTurnNumber?: number };

/** 用户消息的来源：注入类（skill 内容、hook 提醒）不开新 turn，但保留可见。 */
export type ConversationUserMessageOrigin = "human_typed" | "harness_injected";

/** 一个已完成的 turn。摘录都是有界的——本接口的消费者是 prompt，不是对话视图。 */
export interface CompletedConversationTurn {
	turnNumber: number;
	userPromptExcerpt: string;
	assistantResponseExcerpt: string;
	startedAt: string;
	endedAt: string;
	userMessageOrigin: ConversationUserMessageOrigin;
	toolCallCount: number;
}

/** turn 摘录的长度上限，两个 harness 适配器共用（保持 prompt 体量可预期）。 */
export const COMPLETED_CONVERSATION_TURN_EXCERPT_MAX_LENGTH = 400;

/**
 * 投影置信度：`authoritative` = 来源自带 turn 边界事件（dsh）；
 * `transcript_reconstructed` = 由落盘转录重建（Claude Code / Codex），可能有格式漂移。
 */
export type CompletedTurnSequenceProjectionConfidence = "authoritative" | "transcript_reconstructed";

export type CompletedTurnSequenceSourceKind = "claude_code_transcript" | "codex_rollout" | "dsh_session_log";

export interface CompletedTurnSequenceSnapshot {
	conversationSessionId: string;
	sourceKind: CompletedTurnSequenceSourceKind;
	turns: CompletedConversationTurn[];
	/** 变则重算的来源签名（Claude Code：`${mtimeMs}:${size}:${offset}`）；也是漏斗签名对账的键。 */
	sourceSignature: string;
	projectionConfidence: CompletedTurnSequenceProjectionConfidence;
	/**
	 * 末 turn 未闭合时 = 它的编号，且**不进** `turns[]`。
	 * 进行中的末 turn 不参与判定，漏斗对指向它的 turnRef 一律拒绝。
	 */
	inProgressTurnNumber: number | null;
}

export interface CompletedTurnSequenceSource {
	readCompletedTurnSequence(sessionRef: ConversationSessionRef): Promise<CompletedTurnSequenceSnapshot>;
}
