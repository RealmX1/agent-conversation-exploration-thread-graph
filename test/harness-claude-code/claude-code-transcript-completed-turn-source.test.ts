// transcript 判别器与增量投影：用脱敏 fixture 覆盖 A.11 点名的每一类边界记录。

import { appendFile, copyFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationSessionRef } from "../../src/core/index.js";
import {
	ClaudeCodeTranscriptCompletedTurnSource,
	classifyClaudeCodeTranscriptRecord,
	encodeClaudeCodeProjectDirectoryName,
	parseTranscriptJsonRecord,
	readAppendedCompleteJsonLines,
} from "../../src/harness-claude-code/index.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixtureTranscriptPath = join(fixtureDirectory, "claude-code-transcript-desensitized.jsonl");

let workingDirectory = "";
let transcriptPath = "";

beforeEach(async () => {
	workingDirectory = await mkdtemp(join(tmpdir(), "claude-code-transcript-test-"));
	transcriptPath = join(workingDirectory, "session-fixture.jsonl");
	await copyFile(fixtureTranscriptPath, transcriptPath);
});

afterEach(async () => {
	await rm(workingDirectory, { recursive: true, force: true });
});

function buildSessionRef(): ConversationSessionRef {
	return {
		harnessKind: "claude_code",
		nativeSessionId: "session-fixture",
		transcriptPath,
		workingDirectory,
		launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
	};
}

describe("transcript 记录判别器", () => {
	it("按 fixture 逐条给出正确角色", async () => {
		const lines = (await readFile(fixtureTranscriptPath, "utf8")).split("\n").filter((line) => line !== "");
		const roles = lines.map((line) => {
			const record = parseTranscriptJsonRecord(line);
			if (record === null) throw new Error("fixture 里出现了解析不了的行");
			return `${String(record.uuid)}:${classifyClaudeCodeTranscriptRecord(record)}`;
		});
		expect(roles).toEqual([
			"u-000:within_turn_user_record", // isMeta = skill 正文
			"u-001:human_typed_turn_boundary", // promptSource=typed
			"a-001:assistant_message",
			"u-002:within_turn_user_record", // tool_result-only
			"a-002:assistant_message",
			"sc-001:unrelated_to_turn_projection", // isSidechain
			"u-003:harness_injected_user_message", // task-notification
			"a-003:assistant_message",
			"at-001:unrelated_to_turn_projection",
			"m-001:unrelated_to_turn_projection",
			"u-004:human_typed_turn_boundary", // promptSource=queued
			"a-004:assistant_message",
			"u-005:human_typed_turn_boundary",
		]);
	});

	it("工作目录编码保留前导短横（否则按 cwd 定位不到 projects 目录）", () => {
		expect(encodeClaudeCodeProjectDirectoryName("/Users/me/repo")).toBe("-Users-me-repo");
	});
});

describe("transcript 增量投影", () => {
	it("末 turn 默认算进行中，不进 turns[]", async () => {
		const source = new ClaudeCodeTranscriptCompletedTurnSource();
		const snapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(snapshot.turns.map((turn) => turn.turnNumber)).toEqual([1, 2]);
		expect(snapshot.inProgressTurnNumber).toBe(3);
		expect(snapshot.projectionConfidence).toBe("transcript_reconstructed");
	});

	it("Stop 边沿触发时末 turn 算已完成", async () => {
		const source = new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
		const snapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(snapshot.turns.map((turn) => turn.turnNumber)).toEqual([1, 2, 3]);
		expect(snapshot.inProgressTurnNumber).toBeNull();
	});

	it("摘录取最后一段 text，注入消息不开新 turn 但其后的助手输出归入当前 turn", async () => {
		const source = new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
		const snapshot = await source.readCompletedTurnSequence(buildSessionRef());
		const [firstTurn, secondTurn] = snapshot.turns;
		expect(firstTurn?.userPromptExcerpt).toBe("帮我看看缓存命中的问题");
		// task-notification 之后的助手回答仍算 turn 1 的结论，且取最后一段 text。
		expect(firstTurn?.assistantResponseExcerpt).toBe("收到后台通知，继续。");
		expect(firstTurn?.toolCallCount).toBe(2);
		expect(firstTurn?.startedAt).toBe("2026-09-01T10:00:10.000Z");
		expect(firstTurn?.endedAt).toBe("2026-09-01T10:00:47.000Z");
		expect(secondTurn?.userPromptExcerpt).toBe("换个话题：作业该多久跑一次");
		expect(secondTurn?.toolCallCount).toBe(0);
	});

	it("增量追加：第二次只读新行，turn 编号继续单调", async () => {
		const source = new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
		const firstSnapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(firstSnapshot.turns).toHaveLength(3);

		await appendFile(
			transcriptPath,
			`${JSON.stringify({
				type: "user",
				uuid: "u-006",
				sessionId: "session-fixture",
				timestamp: "2026-09-01T10:03:00.000Z",
				isSidechain: false,
				promptSource: "typed",
				message: { role: "user", content: "再来一个 turn" },
			})}\n`,
			"utf8",
		);
		const secondSnapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(secondSnapshot.turns.map((turn) => turn.turnNumber)).toEqual([1, 2, 3, 4]);
		expect(secondSnapshot.turns[3]?.userPromptExcerpt).toBe("再来一个 turn");
		expect(secondSnapshot.sourceSignature).not.toBe(firstSnapshot.sourceSignature);
	});

	it("半行 tail 不参与解析，补全后才计入", async () => {
		const halfLine = '{"type":"user","uuid":"u-007","promptSource":"typed","message":{"role":"user","content":"半行';
		await appendFile(transcriptPath, halfLine, "utf8");
		const source = new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
		expect((await source.readCompletedTurnSequence(buildSessionRef())).turns).toHaveLength(3);

		await appendFile(transcriptPath, '被补全了"}}\n', "utf8");
		const completedSnapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(completedSnapshot.turns).toHaveLength(4);
		expect(completedSnapshot.turns[3]?.userPromptExcerpt).toBe("半行被补全了");
	});

	it("文件被截断（变小）时整份重算，不残留旧 turn", async () => {
		const source = new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
		expect((await source.readCompletedTurnSequence(buildSessionRef())).turns).toHaveLength(3);

		const originalText = await readFile(transcriptPath, "utf8");
		const firstThreeLines = originalText.split("\n").slice(0, 3).join("\n");
		await writeFile(transcriptPath, `${firstThreeLines}\n`, "utf8");
		const rebuiltSnapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(rebuiltSnapshot.turns.map((turn) => turn.turnNumber)).toEqual([1]);
	});

	it("transcript 不存在时降级为空快照而不是抛错", async () => {
		await rm(transcriptPath);
		const source = new ClaudeCodeTranscriptCompletedTurnSource();
		const snapshot = await source.readCompletedTurnSequence(buildSessionRef());
		expect(snapshot.turns).toEqual([]);
		expect(snapshot.sourceSignature).toBe("unavailable");
	});

	it("有界读取只推进到完整换行", async () => {
		await truncate(transcriptPath, 0);
		await writeFile(transcriptPath, '{"a":1}\n{"b":2}\n{"c":', "utf8");
		const result = await readAppendedCompleteJsonLines(transcriptPath, 0);
		expect(result.completeLines).toEqual(['{"a":1}', '{"b":2}']);
		expect(result.nextByteOffset).toBe(16);
		expect(result.fileWasTruncated).toBe(false);
	});
});
