// Claude Code transcript 记录的边界判别（handoff A.6）。
//
// 判据取自本机 25 份真实 transcript（>200KB）的实测分布，不是猜的：
//   promptSource × origin.kind ——
//     typed × human(125) / typed × 缺席(111) / queued × 缺席(47) / queued × human(12) / 缺席 × human(2)  ⇒ 人类输入
//     system × task-notification(30)                                                                   ⇒ harness 注入
//     sdk × 缺席(8)                                                                                     ⇒ 程序化投递
//     两者都缺席                                                                                        ⇒ 根本不是边界（tool_result 等 turn 内记录）
//   isMeta=true(68) ⇒ skill 正文 / 图片附件 / hook 旁白，一律不开新 turn。
//
// 「不开新 turn」与「不可见」是两回事：注入类记录保留 userMessageOrigin 供 prompt 展示，
// 只是不成为 turn 边界——否则一条 hook 提醒就会把一个 turn 劈成两半，turn 编号随之全错。

/** 记录相对 turn 的角色。 */
export type ClaudeCodeTranscriptRecordRole =
	/** 人类输入，开启新 turn。 */
	| "human_typed_turn_boundary"
	/** harness 注入的用户消息：可见，但不开新 turn。 */
	| "harness_injected_user_message"
	/** turn 内的用户记录（tool_result、续接片段等）。 */
	| "within_turn_user_record"
	/** 助手消息：贡献回答摘录与工具调用计数。 */
	| "assistant_message"
	/** 与 turn 投影无关的记录（附件、模式切换、标题、快照等）。 */
	| "unrelated_to_turn_projection";

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function readOriginKind(record: Record<string, unknown>): string | null {
	const origin = record.origin;
	if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return null;
	const kind = (origin as Record<string, unknown>).kind;
	return typeof kind === "string" ? kind : null;
}

function readMessageContentBlocks(record: Record<string, unknown>): Record<string, unknown>[] | null {
	const message = record.message;
	if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return null;
	return content.filter(
		(block): block is Record<string, unknown> => typeof block === "object" && block !== null && !Array.isArray(block),
	);
}

/** 用户消息的正文：content 可能是裸字符串，也可能是 block 数组。 */
export function readUserMessageText(record: Record<string, unknown>): string {
	const message = record.message;
	if (typeof message !== "object" || message === null || Array.isArray(message)) return "";
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	const blocks = readMessageContentBlocks(record);
	if (blocks === null) return "";
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** 助手消息里的 text block 拼接（thinking / tool_use 不算回答正文）。 */
export function readAssistantMessageText(record: Record<string, unknown>): string {
	const blocks = readMessageContentBlocks(record);
	if (blocks === null) return "";
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** 助手消息里的 tool_use 块数——turn 的「干了多少活」指标。 */
export function countAssistantToolUseBlocks(record: Record<string, unknown>): number {
	const blocks = readMessageContentBlocks(record);
	if (blocks === null) return 0;
	return blocks.filter((block) => block.type === "tool_use").length;
}

function userRecordContainsOnlyToolResults(record: Record<string, unknown>): boolean {
	const blocks = readMessageContentBlocks(record);
	if (blocks === null || blocks.length === 0) return false;
	return blocks.every((block) => block.type === "tool_result");
}

export function classifyClaudeCodeTranscriptRecord(record: Record<string, unknown>): ClaudeCodeTranscriptRecordRole {
	const recordType = readString(record, "type");
	if (recordType === "assistant") {
		// 子代理（sidechain）的消息不属于主对话，不能计入主会话的 turn。
		return record.isSidechain === true ? "unrelated_to_turn_projection" : "assistant_message";
	}
	if (recordType !== "user") {
		return "unrelated_to_turn_projection";
	}
	if (record.isSidechain === true) {
		return "unrelated_to_turn_projection";
	}
	// isMeta：skill 正文、图片附件、hook 旁白——是 turn 内容，不是 turn 起点。
	if (record.isMeta === true) {
		return "within_turn_user_record";
	}
	if (userRecordContainsOnlyToolResults(record)) {
		return "within_turn_user_record";
	}

	const promptSource = readString(record, "promptSource");
	const originKind = readOriginKind(record);
	if (promptSource === "typed" || promptSource === "queued" || originKind === "human") {
		return "human_typed_turn_boundary";
	}
	if (promptSource === "system" || promptSource === "sdk" || originKind === "task-notification") {
		return "harness_injected_user_message";
	}
	// 两个标识都缺席 ⇒ 不是边界。旧版本 transcript 也走这条：宁可少开 turn，
	// 也不能把 turn 内记录当成边界——那会让编号整体错位，而编号是本包的地基。
	return "within_turn_user_record";
}

/** 记录的时间戳（ISO 字符串）；缺失时回 null，由调用方决定怎么退化。 */
export function readTranscriptRecordTimestamp(record: Record<string, unknown>): string | null {
	return readString(record, "timestamp");
}
