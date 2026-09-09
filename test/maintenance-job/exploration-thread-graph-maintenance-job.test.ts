// 维护作业端到端：真 transcript fixture + 真 store + 真漏斗，只把 fork 执行器换成夹具回放。
// 这条链覆盖 A.11 的「CLI e2e」：fixture → maintain(initial_backfill) → get --view 断言 lane 与边。

import { appendFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentConversationExplorationThreadGraphCli } from "../../src/cli/agent-conversation-exploration-thread-graph-cli.js";
import {
	buildExplorationThreadGraphMaintenanceProposalJsonSchema,
	type CompletedTurnSequenceSnapshot,
	type CompletedTurnSequenceSource,
	type ConversationSessionRef,
	type ForkedWorkBranchExecutor,
	type ForkedWorkBranchRequest,
	type ForkedWorkBranchResult,
	runExplorationThreadGraphMaintenanceJob,
} from "../../src/core/index.js";
import { ClaudeCodeTranscriptCompletedTurnSource } from "../../src/harness-claude-code/index.js";
import { createFakeClaudeExecutableDirectory } from "../fixtures/exploration-thread-graph-test-doubles.js";

const fixtureTranscriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"claude-code-transcript-desensitized.jsonl",
);

/** 回放固定 proposal 的执行器夹具；同时记下它收到的 prompt 与 schema 供断言。 */
class ReplayingForkedWorkBranchExecutor implements ForkedWorkBranchExecutor {
	lastRequest: ForkedWorkBranchRequest | null = null;
	constructor(private readonly structuredProposal: unknown) {}
	async start(request: ForkedWorkBranchRequest): Promise<ForkedWorkBranchResult> {
		this.lastRequest = request;
		return {
			structured: this.structuredProposal,
			outputText: JSON.stringify(this.structuredProposal),
			stopReason: "completed",
			usage: { inputTokens: 12, cacheReadInputTokens: 0, outputTokens: 34, costUsd: 1.23 },
			forkedNativeSessionId: "forked-session-for-test",
		};
	}
}

/**
 * 分身跑着的时候用户又聊了一轮：`start()` 在返回提案**之前**往 transcript 追加一个新的人类 turn。
 * 这正是闸 2 要防的时序——作业的判定基于的快照，在落盘那一刻已经过期。
 */
class TranscriptAppendingDuringForkExecutor implements ForkedWorkBranchExecutor {
	constructor(
		private readonly structuredProposal: unknown,
		private readonly transcriptPathToAppend: string,
	) {}
	async start(): Promise<ForkedWorkBranchResult> {
		const newHumanTurnRecord = {
			type: "user",
			uuid: "u-appended-during-fork",
			parentUuid: null,
			sessionId: "session-fixture",
			timestamp: "2026-09-01T10:05:00.000Z",
			isSidechain: false,
			promptSource: "typed",
			origin: { kind: "human" },
			userType: "external",
			message: { role: "user", content: "作业还没回来我就又问了一句" },
		};
		await appendFile(this.transcriptPathToAppend, `${JSON.stringify(newHumanTurnRecord)}\n`, "utf8");
		return {
			structured: this.structuredProposal,
			outputText: JSON.stringify(this.structuredProposal),
			stopReason: "completed",
		};
	}
}

/** 只做计数的转发来源：用来断言「fork 返回后确实又重读了一次 turnSource」。 */
class ReadCountingCompletedTurnSource implements CompletedTurnSequenceSource {
	readCompletedTurnSequenceCallCount = 0;
	constructor(private readonly delegate: CompletedTurnSequenceSource) {}
	async readCompletedTurnSequence(sessionRef: ConversationSessionRef): Promise<CompletedTurnSequenceSnapshot> {
		this.readCompletedTurnSequenceCallCount += 1;
		return await this.delegate.readCompletedTurnSequence(sessionRef);
	}
}

let workspaceDirectory = "";
let storeRoot = "";
let transcriptPath = "";

beforeEach(async () => {
	workspaceDirectory = await mkdtemp(join(tmpdir(), "maintenance-job-test-"));
	storeRoot = join(workspaceDirectory, "store");
	transcriptPath = join(workspaceDirectory, "session-fixture.jsonl");
	await copyFile(fixtureTranscriptPath, transcriptPath);
});

afterEach(async () => {
	await rm(workspaceDirectory, { recursive: true, force: true });
});

function buildSessionRef(): ConversationSessionRef {
	return {
		harnessKind: "claude_code",
		nativeSessionId: "session-fixture",
		transcriptPath,
		workingDirectory: workspaceDirectory,
		launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
	};
}

/** fixture transcript 有 3 个 turn：turn 1-2 一条线，turn 3 偏离出第二条线并收口第一条。 */
function buildReplayProposal(): Record<string, unknown> {
	const turnRef = (turnNumber: number) => ({
		conversationSessionId: "session-fixture",
		turnNumber,
		turnCheckpointCommit: null,
	});
	return {
		topicProposals: [
			{
				temporaryTopicId: "tmp-topic-cache",
				topicTitle: "缓存命中调查",
				topicAliases: [],
				topicSummaryMarkdown: "为什么 fork 不命中",
			},
			{
				temporaryTopicId: "tmp-topic-cadence",
				topicTitle: "作业触发频率",
				topicAliases: [],
				topicSummaryMarkdown: "多久跑一次维护作业",
			},
		],
		newThreads: [
			{
				temporaryThreadId: "tmp-thread-cache",
				threadTitle: "缓存命中调查",
				parentThreadId: null,
				forkedFromTurnRef: null,
				primaryTopicId: "tmp-topic-cache",
			},
			{
				temporaryThreadId: "tmp-thread-cadence",
				threadTitle: "作业触发频率",
				parentThreadId: "tmp-thread-cache",
				forkedFromTurnRef: turnRef(1),
				primaryTopicId: "tmp-topic-cadence",
			},
		],
		placements: [
			{ turnRef: turnRef(1), threadId: "tmp-thread-cache", placementConfidence: "high", deviationRationale: null },
			{
				turnRef: turnRef(2),
				threadId: "tmp-thread-cadence",
				placementConfidence: "high",
				deviationRationale: "用户明说换个话题",
			},
			{
				turnRef: turnRef(3),
				threadId: "tmp-thread-cache",
				placementConfidence: "low",
				deviationRationale: "回到缓存那条线",
			},
		],
		edges: [
			{ sourceTurnRef: turnRef(2), edgeKind: "forks_from", targetTurnRef: turnRef(1), targetThreadId: null },
			{ sourceTurnRef: turnRef(3), edgeKind: "returns_to", targetTurnRef: turnRef(1), targetThreadId: null },
			{
				sourceTurnRef: turnRef(3),
				edgeKind: "concludes",
				targetTurnRef: null,
				targetThreadId: "tmp-thread-cadence",
			},
		],
		eventMarks: [{ turnRef: turnRef(1), mark: "open_question", note: "cache 为什么是 0", externalReferenceId: null }],
		threadRevisions: [],
		subjectTaggings: [{ turnRef: turnRef(1), turnSubjectTags: ["prompt cache", "Prompt Cache", " fork "] }],
	};
}

describe("维护作业端到端", () => {
	it("initial_backfill 落盘后，get --view 能出多 lane 与合流边", async () => {
		const executor = new ReplayingForkedWorkBranchExecutor(buildReplayProposal());
		const jobResult = await runExplorationThreadGraphMaintenanceJob({
			explorationId: "task-1",
			sessions: [buildSessionRef()],
			turnSource: new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true }),
			executor,
			storeRoot,
			mode: "initial_backfill",
		});
		expect(jobResult.outcome).toBe("accepted");
		if (jobResult.outcome !== "accepted") throw new Error("上一行已断言 accepted");
		expect(jobResult.placedTurnCount).toBe(3);
		expect(jobResult.remainingTurnCount).toBe(0);
		expect(jobResult.usage).toEqual({ inputTokens: 12, cacheReadInputTokens: 0, outputTokens: 34, costUsd: 1.23 });

		// 分身收到的 outputSchema 必须就是 zod 生成的那份（不是手写的第二份）。
		expect(executor.lastRequest?.outputSchema).toEqual(buildExplorationThreadGraphMaintenanceProposalJsonSchema());
		// prompt 里必须有 turn 对照表，分身才能把编号对上自己的记忆。
		expect(executor.lastRequest?.promptText).toContain("| turn | 用户消息开头 | 当前归属 |");
		expect(executor.lastRequest?.promptText).toContain("帮我看看缓存命中的问题");

		const cliResult = await runAgentConversationExplorationThreadGraphCli([
			"get",
			"--exploration-id",
			"task-1",
			"--store-root",
			storeRoot,
			"--view",
			"--session",
			JSON.stringify(buildSessionRef()),
		]);
		expect(cliResult.exitCode).toBe(0);
		const parsed = JSON.parse(cliResult.output) as {
			view: {
				turnRows: { turnRowId: string; threadId: string | null; parentTurnRowIds: string[] }[];
				threads: {
					thread: { threadId: string; threadTitle: string };
					primaryTopic: { topicTitle: string } | null;
				}[];
				laneCount: number;
				staleReason: string | null;
			};
		};
		expect(parsed.view.laneCount).toBe(2);
		expect(parsed.view.staleReason).toBeNull();
		expect(parsed.view.threads.map((entry) => entry.thread.threadId)).toEqual(["thread-1", "thread-2"]);
		expect(parsed.view.threads[1]?.primaryTopic?.topicTitle).toBe("作业触发频率");
		// turn 3 回到 thread-1 并收口 thread-2 ⇒ 两个 parent（合流线）。
		const turnThreeRow = parsed.view.turnRows.find((row) => row.turnRowId === "session-fixture#3");
		expect(turnThreeRow?.threadId).toBe("thread-1");
		expect(turnThreeRow?.parentTurnRowIds).toEqual(["session-fixture#1", "session-fixture#2"]);
	});

	it("标签按规范化去重后落盘", async () => {
		await runExplorationThreadGraphMaintenanceJob({
			explorationId: "task-1",
			sessions: [buildSessionRef()],
			turnSource: new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true }),
			executor: new ReplayingForkedWorkBranchExecutor(buildReplayProposal()),
			storeRoot,
			mode: "initial_backfill",
		});
		const cliResult = await runAgentConversationExplorationThreadGraphCli([
			"get",
			"--exploration-id",
			"task-1",
			"--store-root",
			storeRoot,
		]);
		const parsed = JSON.parse(cliResult.output) as {
			collection: { turnSubjectTaggings: { turnSubjectTags: string[] }[] };
		};
		// "prompt cache" / "Prompt Cache" / " fork " ⇒ 去重 + trim 后只剩两条。
		expect(parsed.collection.turnSubjectTaggings[0]?.turnSubjectTags).toEqual(["prompt cache", "fork"]);
	});

	it("全部 turn 都归位后再跑 incremental 会 skip", async () => {
		const commonJobInput = {
			explorationId: "task-1",
			sessions: [buildSessionRef()],
			turnSource: new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true }),
			storeRoot,
		} as const;
		await runExplorationThreadGraphMaintenanceJob({
			...commonJobInput,
			executor: new ReplayingForkedWorkBranchExecutor(buildReplayProposal()),
			mode: "initial_backfill",
		});
		const secondRun = await runExplorationThreadGraphMaintenanceJob({
			...commonJobInput,
			executor: new ReplayingForkedWorkBranchExecutor(buildReplayProposal()),
			mode: "initial_backfill",
		});
		expect(secondRun).toMatchObject({ outcome: "skipped", skipReason: "no_turns_under_judgement" });
	});

	it("分身跑着的时候来了新 turn ⇒ 落盘前重读 turnSource，闸 2 拒绝且只落 stale 标记", async () => {
		const readCountingTurnSource = new ReadCountingCompletedTurnSource(
			new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true }),
		);
		const result = await runExplorationThreadGraphMaintenanceJob({
			explorationId: "task-1",
			sessions: [buildSessionRef()],
			turnSource: readCountingTurnSource,
			executor: new TranscriptAppendingDuringForkExecutor(buildReplayProposal(), transcriptPath),
			storeRoot,
			mode: "initial_backfill",
		});
		expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "turn_source_signature_mismatch" });
		// 发起时读一次 + 落盘前在写锁内重读一次；只读一次就说明签名对账是同源自比。
		expect(readCountingTurnSource.readCompletedTurnSequenceCallCount).toBe(2);

		const cliResult = await runAgentConversationExplorationThreadGraphCli([
			"get",
			"--exploration-id",
			"task-1",
			"--store-root",
			storeRoot,
		]);
		const parsed = JSON.parse(cliResult.output) as {
			collection: { threads: unknown[]; turnThreadPlacements: unknown[]; staleReason: string | null };
		};
		expect(parsed.collection.threads).toEqual([]);
		expect(parsed.collection.turnThreadPlacements).toEqual([]);
		expect(parsed.collection.staleReason).toBe("turn_source_signature_changed");
	});

	it("分身漏判待判 turn 时整份拒绝，什么都不落盘", async () => {
		// 待判范围由作业算出并原样交给漏斗；分身交白卷不该被当成一次成功确认。
		const emptyProposalExecutor = new ReplayingForkedWorkBranchExecutor({
			placements: [],
			newThreads: [],
			topicProposals: [],
			edges: [],
			eventMarks: [],
			threadRevisions: [],
			subjectTaggings: [],
		});
		const result = await runExplorationThreadGraphMaintenanceJob({
			explorationId: "task-1",
			sessions: [buildSessionRef()],
			turnSource: new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true }),
			executor: emptyProposalExecutor,
			storeRoot,
			mode: "initial_backfill",
		});
		expect(result).toMatchObject({
			outcome: "rejected",
			rejectionReason: "placement_missing_for_turn_under_judgement",
		});
		const cliResult = await runAgentConversationExplorationThreadGraphCli([
			"get",
			"--exploration-id",
			"task-1",
			"--store-root",
			storeRoot,
		]);
		expect(
			(JSON.parse(cliResult.output) as { collection: { turnThreadPlacements: unknown[] } }).collection
				.turnThreadPlacements,
		).toEqual([]);
	});

	it("分身失败时不落盘，如实回报 stopReason", async () => {
		const failingExecutor: ForkedWorkBranchExecutor = {
			async start(): Promise<ForkedWorkBranchResult> {
				return { outputText: "分身超时了", stopReason: "timeout" };
			},
		};
		const result = await runExplorationThreadGraphMaintenanceJob({
			explorationId: "task-1",
			sessions: [buildSessionRef()],
			turnSource: new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true }),
			executor: failingExecutor,
			storeRoot,
			mode: "initial_backfill",
		});
		expect(result).toMatchObject({ outcome: "fork_failed", stopReason: "timeout" });
		const cliResult = await runAgentConversationExplorationThreadGraphCli([
			"get",
			"--exploration-id",
			"task-1",
			"--store-root",
			storeRoot,
		]);
		expect((JSON.parse(cliResult.output) as { collection: { threads: unknown[] } }).collection.threads).toEqual([]);
	});

	it("没有会话时直接 skip", async () => {
		const result = await runExplorationThreadGraphMaintenanceJob({
			explorationId: "task-1",
			sessions: [],
			turnSource: new ClaudeCodeTranscriptCompletedTurnSource(),
			executor: new ReplayingForkedWorkBranchExecutor({}),
			storeRoot,
			mode: "incremental",
		});
		expect(result).toMatchObject({ outcome: "skipped", skipReason: "no_sessions" });
	});
});

describe("CLI 其余子命令", () => {
	it("schema 输出 object-rooted JSON Schema", async () => {
		const result = await runAgentConversationExplorationThreadGraphCli(["schema"]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output) as { type: string; properties: Record<string, unknown> };
		expect(parsed.type).toBe("object");
		expect(Object.keys(parsed.properties)).toContain("placements");
	});

	it("doctor 对可读 transcript 通过，对缺失 transcript 与被禁参数不通过", async () => {
		// doctor 还要探测 `claude` 可执行（handoff A.7），用假可执行文件把 PATH 钉死，
		// 免得「通过」这一支随跑测机器上装没装 claude 而变。
		const originalSearchPath = process.env.PATH;
		process.env.PATH = await createFakeClaudeExecutableDirectory(workspaceDirectory);
		try {
			const passing = await runAgentConversationExplorationThreadGraphCli([
				"doctor",
				"--session",
				JSON.stringify(buildSessionRef()),
			]);
			expect(passing.exitCode).toBe(0);
		} finally {
			process.env.PATH = originalSearchPath;
		}

		const missingTranscript = await runAgentConversationExplorationThreadGraphCli([
			"doctor",
			"--session",
			JSON.stringify({ ...buildSessionRef(), transcriptPath: join(workspaceDirectory, "不存在.jsonl") }),
		]);
		expect(missingTranscript.exitCode).toBe(1);

		const sessionRef = buildSessionRef();
		if (sessionRef.harnessKind !== "claude_code") throw new Error("夹具应当是 claude_code 会话");
		const forbiddenArgs = await runAgentConversationExplorationThreadGraphCli([
			"doctor",
			"--session",
			JSON.stringify({
				...sessionRef,
				launchArgvTemplate: { ...sessionRef.launchArgvTemplate, extraArgs: ["--bare"] },
			}),
		]);
		expect(forbiddenArgs.exitCode).toBe(1);
		expect(forbiddenArgs.output).toContain("--bare");
	});

	it("maintain 缺参数时给出可读错误", async () => {
		const missingExplorationId = await runAgentConversationExplorationThreadGraphCli(["maintain"]);
		expect(missingExplorationId.exitCode).toBe(2);
		expect(missingExplorationId.output).toContain("--exploration-id");

		const badMode = await runAgentConversationExplorationThreadGraphCli([
			"maintain",
			"--exploration-id",
			"task-1",
			"--mode",
			"乱写",
		]);
		expect(badMode.exitCode).toBe(2);
		expect(badMode.output).toContain("--mode");
	});
});
