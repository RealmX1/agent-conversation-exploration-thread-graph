// 维护作业的 prompt 组装（handoff A.5）。
//
// 这份 prompt 的读者是**主会话的分身**：它已经拥有整段对话的上下文，所以这里不复述内容，
// 只做三件事——把 turn 编号对上它记忆里的消息（对照表）、给出判据、规定输出形状。
// 对照表是关键：分身不知道宿主怎么编号，必须靠「编号 ↔ 用户消息前 80 字」把两边对齐。

import type { CompletedTurnSequenceSnapshot } from "../completed-turn-sequence-source.js";
import type { ExplorationThreadGraphCollection, ExplorationTopicRegistry } from "../exploration-thread-graph-schema.js";
import { formatExplorationTurnRefKey } from "../exploration-thread-graph-schema.js";

/** 对照表里每条用户消息展示多少字：够对上号即可，太长会白烧 token。 */
const TURN_LOOKUP_TABLE_EXCERPT_LENGTH = 80;

export type ExplorationThreadGraphMaintenanceJobMode = "initial_backfill" | "incremental";

export interface MaintenanceJobPromptAssemblyInput {
	mode: ExplorationThreadGraphMaintenanceJobMode;
	/** 主会话在前；by-the-way 会话的 turn 也列出来，但它们的分叉锚点由宿主直接给，作业不判。 */
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>;
	primaryConversationSessionId: string;
	forkedFromParentSessionTurnNumberBySession: Readonly<Record<string, number>>;
	currentCollection: ExplorationThreadGraphCollection;
	currentTopicRegistry: ExplorationTopicRegistry;
	/** 本次要判定的 turn（已按模式与批次算好）。 */
	turnsUnderJudgement: readonly { conversationSessionId: string; turnNumber: number }[];
	revisionWindowTurnCount: number;
}

function truncateForLookupTable(text: string): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length <= TURN_LOOKUP_TABLE_EXCERPT_LENGTH
		? collapsed
		: `${collapsed.slice(0, TURN_LOOKUP_TABLE_EXCERPT_LENGTH)}…`;
}

function renderTurnLookupTable(input: MaintenanceJobPromptAssemblyInput): string {
	const placementByTurnKey = new Map(
		input.currentCollection.turnThreadPlacements.map((placement) => [
			formatExplorationTurnRefKey(placement.turnRef),
			placement,
		]),
	);
	const threadById = new Map(input.currentCollection.threads.map((thread) => [thread.threadId, thread]));
	const topicById = new Map(input.currentTopicRegistry.topics.map((topic) => [topic.topicId, topic]));

	const lines: string[] = [];
	for (const [conversationSessionId, snapshot] of input.turnSnapshotsBySession) {
		const isPrimary = conversationSessionId === input.primaryConversationSessionId;
		const forkedFromTurnNumber = input.forkedFromParentSessionTurnNumberBySession[conversationSessionId];
		const sessionHeading = isPrimary
			? `### 主会话 \`${conversationSessionId}\``
			: `### by-the-way 会话 \`${conversationSessionId}\`（自主会话 turn ${forkedFromTurnNumber ?? "?"} 分出）`;
		lines.push(sessionHeading, "", "| turn | 用户消息开头 | 当前归属 |", "| --- | --- | --- |");
		for (const turn of snapshot.turns) {
			const placement = placementByTurnKey.get(
				formatExplorationTurnRefKey({ conversationSessionId, turnNumber: turn.turnNumber }),
			);
			const thread = placement === undefined ? undefined : threadById.get(placement.threadId);
			const topic = thread === undefined ? undefined : topicById.get(thread.primaryTopicId);
			const placementText =
				placement === undefined
					? "尚未归位"
					: `${placement.threadId}（${thread?.threadTitle ?? "?"}${topic === undefined ? "" : ` / 主题：${topic.topicTitle}`}）`;
			lines.push(`| ${turn.turnNumber} | ${truncateForLookupTable(turn.userPromptExcerpt)} | ${placementText} |`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderExistingThreadsAndTopics(input: MaintenanceJobPromptAssemblyInput): string {
	if (input.currentCollection.threads.length === 0) {
		return "（还没有任何 thread —— 这是首次判定，你需要从头建线。）";
	}
	const topicById = new Map(input.currentTopicRegistry.topics.map((topic) => [topic.topicId, topic]));
	const lines = ["| threadId | 标题 | 状态 | 主题 | 父线 |", "| --- | --- | --- | --- | --- |"];
	for (const thread of input.currentCollection.threads) {
		const topic = topicById.get(thread.primaryTopicId);
		lines.push(
			`| ${thread.threadId} | ${thread.threadTitle} | ${thread.threadLifecycleStatus} | ${topic?.topicTitle ?? thread.primaryTopicId} | ${thread.parentThreadId ?? "（根）"} |`,
		);
	}
	const reusableTopicTitles = input.currentTopicRegistry.topics
		.map((topic) => topic.topicTitle)
		.slice(0, 40)
		.join("、");
	if (reusableTopicTitles !== "") {
		lines.push("", `可复用的既有主题：${reusableTopicTitles}`);
	}
	return lines.join("\n");
}

function renderTurnsUnderJudgement(input: MaintenanceJobPromptAssemblyInput): string {
	if (input.turnsUnderJudgement.length === 0) {
		return "（本次没有待判 turn。）";
	}
	const bySession = new Map<string, number[]>();
	for (const turn of input.turnsUnderJudgement) {
		const bucket = bySession.get(turn.conversationSessionId) ?? [];
		bucket.push(turn.turnNumber);
		bySession.set(turn.conversationSessionId, bucket);
	}
	return [...bySession.entries()]
		.map(([conversationSessionId, turnNumbers]) => `- \`${conversationSessionId}\`：turn ${turnNumbers.join("、")}`)
		.join("\n");
}

export function assembleExplorationThreadGraphMaintenanceJobPrompt(input: MaintenanceJobPromptAssemblyInput): string {
	const modeDescription =
		input.mode === "initial_backfill"
			? "首次全量归位：下面列出的 turn 都还没有归属，你要给每一个都定一条线。"
			: `增量维护：只判下面列出的 turn（新 turn + 最近 ${input.revisionWindowTurnCount} 个可修订的已归位 turn）。`;

	return [
		"# 你的任务：为这次探索场次维护 thread graph",
		"",
		"你是**本会话的分身**——你拥有这段对话的完整上下文，所以不需要我把内容复述给你。",
		"你的唯一产出是一份 JSON，**不要执行任何工具、不要输出 JSON 以外的任何东西**。",
		"",
		"## 模型：thread graph",
		"",
		"把这次探索看成一张 git 图：**thread = 分支（一条时间性探索线）**，**turn = 提交**，",
		"关系边 = 分叉与合流。每个 turn 恰好属于一条 thread。",
		"",
		"## 什么算「偏离」",
		"",
		"偏离 = **读者在导航图上会希望单独拉一条线来看的方向变化**。判据不是话题词变了，而是探索方向变了。常见线索：",
		"",
		"- 用户明说换话题（「先放一放」「另外一件事」「回到刚才那个」）；",
		"- by-the-way 措辞：顺带问一个与主线无关的问题；",
		"- 回到先前某个问题继续（这是**回归既有 thread**，不是新建）；",
		"- 一个新假设被展开成独立的调查线。",
		"",
		"仅仅是同一条线里的深入、追问、修正**不算**偏离。判偏离必须给 `deviationRationale`。",
		"",
		"## 待判 turn 的对照表",
		"",
		"编号是宿主给的权威编号，请用「用户消息开头」把它对上你记忆里的那条消息。",
		"",
		renderTurnLookupTable(input),
		"## 现有的 thread 与主题",
		"",
		renderExistingThreadsAndTopics(input),
		"",
		"## 本次待判范围",
		"",
		modeDescription,
		"",
		renderTurnsUnderJudgement(input),
		"",
		"## 每个待判 turn 逐条走这张清单",
		"",
		"1. **延续还是偏离**？偏离必须填 `deviationRationale`。",
		"2. 偏离的去向三选一：**回归**某条既有 thread（填它的 `threadId`）/ **分叉**出新 thread（给父线 + 锚点 turn，锚点默认是上一个 turn；用户明说「回到 T3」就锚 T3）/ **平地起**的 by-the-way（父线填 null）。",
		"3. 新 thread 的父级是谁。",
		"4. 新 thread 的标题（≤80 字）与主题（标题 ≤80 + 一句摘要）。**能复用上面列出的既有主题就复用**，不要造近义词。",
		"5. 如果这个 turn 离开了某条 thread，给那条线一个 `concludes` 边并在 `threadRevisions` 里改它的状态。",
		"6. 值得标注的事件（里程碑 / 决策点 / 待解问题 / 潜在发现），可选。",
		"7. `turnSubjectTags`：这个 turn 涉及的主题标签（≤8，多主题就多标签）。",
		"8. `placementConfidence`：拿不准就填 `low` 并说明理由，不要硬撑 `high`。",
		"",
		"最后再做一件事：**复核所有 active thread 的标题与主题是否还贴切**。探索走远之后早先的命名常常太窄，",
		"该拓宽就在 `threadRevisions` 里改——这是无损操作，会自动应用。",
		"",
		"## 输出规则",
		"",
		"- 新建的 thread / topic **只能用临时 id**（例如 `tmp-thread-1`、`tmp-topic-1`），正式 id 由系统派生。",
		"  在 `placements`、`edges`、`newThreads.parentThreadId` 里引用它们时用同一个临时 id。",
		"- 关系边只能指向**更早**的 turn；`concludes` 边指向 thread（填 `targetThreadId`，`targetTurnRef` 留 null），",
		"  其余四种指向 turn（填 `targetTurnRef`，`targetThreadId` 留 null）。",
		"- 每个 turn 在 `placements` 里**恰好出现一次**。",
		"- 只输出符合 schema 的 JSON 对象，不要加解释、不要加 markdown 代码块以外的任何文字。",
	].join("\n");
}
