#!/usr/bin/env node
// bin `agent-conversation-exploration-thread-graph`：maintain / get / schema / doctor（handoff A.7）。
//
// 形状纪律：子命令一律是**返回 `{exitCode, output}` 的纯函数**，只有文件末尾的可执行守卫写 stdout。
// 这样 CLI 的每条路径都能在单测里直接断言，不必去捞进程输出。

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildExplorationThreadGraphMaintenanceProposalJsonSchema,
	buildExplorationThreadGraphProjectionView,
	type CompletedTurnSequenceSnapshot,
	type ConversationSessionRef,
	type ExplorationThreadGraphMaintenanceJobMode,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
	runExplorationThreadGraphMaintenanceJob,
} from "../core/index.js";
import {
	ClaudeCodeForkedSessionWorkBranchExecutor,
	ClaudeCodeTranscriptCompletedTurnSource,
} from "../harness-claude-code/index.js";

/** 计划中的子命令名清单。 */
export const AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_CLI_SUBCOMMAND_NAMES = [
	"maintain",
	"get",
	"schema",
	"doctor",
] as const;

export type AgentConversationExplorationThreadGraphCliSubcommandName =
	(typeof AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_CLI_SUBCOMMAND_NAMES)[number];

/** 裸用法（无宿主）的默认 storeRoot。 */
export const DEFAULT_BARE_STORE_ROOT = join(homedir(), ".agent-conversation-exploration-thread-graph");

export interface AgentConversationExplorationThreadGraphCliResult {
	exitCode: number;
	output: string;
}

export function renderAgentConversationExplorationThreadGraphCliUsage(): string {
	return [
		"用法：agent-conversation-exploration-thread-graph <subcommand> [options]",
		"",
		"子命令：",
		"  maintain   对一个 exploration 跑一次 work-branch 维护作业",
		"             --exploration-id <id> --store-root <dir> --mode incremental|initial_backfill",
		"             --session <ConversationSessionRef JSON>（可重复，主会话在前）或 --sessions-file <path>",
		"             [--model <argv 字面值，覆盖宿主模板>] [--batch-size <n>] [--timeout-ms <n>]",
		"             [--final-turn-completed]（由 Stop 边沿触发时给上，末 turn 才算已完成）",
		"  get        输出 exploration 的 collection 或 projection view",
		"             --exploration-id <id> --store-root <dir> [--view] [--session <json>...]",
		"  schema     输出维护作业 proposal 的 JSON Schema",
		"  doctor     检查会话引用：transcript 可读、fork 参数模板完整 --session <json>",
		"",
		`storeRoot 默认为 ${DEFAULT_BARE_STORE_ROOT}`,
	].join("\n");
}

interface ParsedCliArguments {
	flags: Map<string, string[]>;
	booleanFlags: Set<string>;
}

function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
	const flags = new Map<string, string[]>();
	const booleanFlags = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined || !token.startsWith("--")) continue;
		const name = token.slice(2);
		const nextToken = argv[index + 1];
		if (nextToken === undefined || nextToken.startsWith("--")) {
			booleanFlags.add(name);
			continue;
		}
		flags.set(name, [...(flags.get(name) ?? []), nextToken]);
		index += 1;
	}
	return { flags, booleanFlags };
}

function readSingleFlag(parsed: ParsedCliArguments, name: string): string | null {
	const values = parsed.flags.get(name);
	return values === undefined ? null : (values[values.length - 1] ?? null);
}

function failure(message: string): AgentConversationExplorationThreadGraphCliResult {
	return { exitCode: 2, output: JSON.stringify({ ok: false, error: message }, null, "\t") };
}

function success(payload: unknown): AgentConversationExplorationThreadGraphCliResult {
	return { exitCode: 0, output: JSON.stringify(payload, null, "\t") };
}

async function resolveSessionRefs(parsed: ParsedCliArguments): Promise<ConversationSessionRef[] | string> {
	const inlineSessionJsonTexts = parsed.flags.get("session") ?? [];
	const sessionsFilePath = readSingleFlag(parsed, "sessions-file");
	const sessionJsonTexts = [...inlineSessionJsonTexts];
	if (sessionsFilePath !== null) {
		try {
			const fileText = await readFile(sessionsFilePath, "utf8");
			const parsedFile = JSON.parse(fileText) as unknown;
			if (!Array.isArray(parsedFile))
				return `--sessions-file 的内容必须是 ConversationSessionRef 数组：${sessionsFilePath}`;
			for (const entry of parsedFile) sessionJsonTexts.push(JSON.stringify(entry));
		} catch (error) {
			return `读不了 --sessions-file ${sessionsFilePath}：${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (sessionJsonTexts.length === 0) return "缺少 --session <json>（可重复）或 --sessions-file <path>";

	const sessionRefs: ConversationSessionRef[] = [];
	for (const sessionJsonText of sessionJsonTexts) {
		let parsedSession: unknown;
		try {
			parsedSession = JSON.parse(sessionJsonText) as unknown;
		} catch {
			return `--session 不是合法 JSON：${sessionJsonText.slice(0, 120)}`;
		}
		if (typeof parsedSession !== "object" || parsedSession === null || Array.isArray(parsedSession)) {
			return "--session 必须是一个 JSON 对象";
		}
		const candidate = parsedSession as Record<string, unknown>;
		if (
			candidate.harnessKind !== "claude_code" &&
			candidate.harnessKind !== "codex" &&
			candidate.harnessKind !== "dsh"
		) {
			return `--session 的 harnessKind 不认识：${String(candidate.harnessKind)}`;
		}
		sessionRefs.push(parsedSession as ConversationSessionRef);
	}
	return sessionRefs;
}

async function runMaintainSubcommand(
	parsed: ParsedCliArguments,
): Promise<AgentConversationExplorationThreadGraphCliResult> {
	const explorationId = readSingleFlag(parsed, "exploration-id");
	if (explorationId === null) return failure("缺少 --exploration-id");
	const storeRoot = readSingleFlag(parsed, "store-root") ?? DEFAULT_BARE_STORE_ROOT;
	const modeText = readSingleFlag(parsed, "mode") ?? "incremental";
	if (modeText !== "incremental" && modeText !== "initial_backfill") {
		return failure(`--mode 只能是 incremental 或 initial_backfill，收到 ${modeText}`);
	}
	const mode: ExplorationThreadGraphMaintenanceJobMode = modeText;
	const sessionRefsOrError = await resolveSessionRefs(parsed);
	if (typeof sessionRefsOrError === "string") return failure(sessionRefsOrError);

	const overrideModel = readSingleFlag(parsed, "model");
	const batchSizeText = readSingleFlag(parsed, "batch-size");
	const timeoutText = readSingleFlag(parsed, "timeout-ms");

	const result = await runExplorationThreadGraphMaintenanceJob({
		explorationId,
		sessions: sessionRefsOrError,
		turnSource: new ClaudeCodeTranscriptCompletedTurnSource({
			treatFinalTurnAsCompleted: parsed.booleanFlags.has("final-turn-completed"),
		}),
		executor: new ClaudeCodeForkedSessionWorkBranchExecutor(overrideModel === null ? {} : { overrideModel }),
		storeRoot,
		mode,
		...(batchSizeText === null ? {} : { batchSize: Number.parseInt(batchSizeText, 10) }),
		...(timeoutText === null ? {} : { timeoutMs: Number.parseInt(timeoutText, 10) }),
	});
	return result.outcome === "accepted" || result.outcome === "skipped"
		? success({ ok: true, ...result })
		: { exitCode: 1, output: JSON.stringify({ ok: false, ...result }, null, "\t") };
}

async function runGetSubcommand(parsed: ParsedCliArguments): Promise<AgentConversationExplorationThreadGraphCliResult> {
	const explorationId = readSingleFlag(parsed, "exploration-id");
	if (explorationId === null) return failure("缺少 --exploration-id");
	const storeRoot = readSingleFlag(parsed, "store-root") ?? DEFAULT_BARE_STORE_ROOT;
	const collection = await readExplorationThreadGraphCollection(storeRoot, explorationId);
	if (!parsed.booleanFlags.has("view")) {
		return success({ ok: true, collection });
	}
	// projection view 需要 turn 快照才能把行摊出来；没给 --session 就只能出一份空行的视图。
	const sessionRefsOrError = await resolveSessionRefs(parsed);
	const turnSnapshotsBySession = new Map<string, CompletedTurnSequenceSnapshot>();
	if (typeof sessionRefsOrError !== "string") {
		const turnSource = new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
		for (const sessionRef of sessionRefsOrError) {
			const snapshot = await turnSource.readCompletedTurnSequence(sessionRef);
			turnSnapshotsBySession.set(snapshot.conversationSessionId, snapshot);
		}
	}
	const topicRegistry = await readExplorationTopicRegistry(storeRoot);
	return success({
		ok: true,
		view: buildExplorationThreadGraphProjectionView(collection, turnSnapshotsBySession, topicRegistry),
	});
}

async function runDoctorSubcommand(
	parsed: ParsedCliArguments,
): Promise<AgentConversationExplorationThreadGraphCliResult> {
	const sessionRefsOrError = await resolveSessionRefs(parsed);
	if (typeof sessionRefsOrError === "string") return failure(sessionRefsOrError);

	const checks: Record<string, unknown>[] = [];
	let allChecksPassed = true;
	for (const sessionRef of sessionRefsOrError) {
		if (sessionRef.harnessKind !== "claude_code") {
			checks.push({
				nativeSessionId: sessionRef.nativeSessionId,
				harnessKind: sessionRef.harnessKind,
				note: "doctor 目前只检查 claude_code 会话",
			});
			continue;
		}
		let transcriptIsReadable = true;
		try {
			await access(sessionRef.transcriptPath);
		} catch {
			transcriptIsReadable = false;
		}
		const { launchArgvTemplate } = sessionRef;
		const forbiddenExtraArgs = launchArgvTemplate.extraArgs.filter(
			(extraArgument) => extraArgument === "--bare" || extraArgument === "--safe-mode",
		);
		const templateIsComplete = typeof launchArgvTemplate.model === "string" && launchArgvTemplate.model !== "";
		const sessionChecksPassed = transcriptIsReadable && templateIsComplete && forbiddenExtraArgs.length === 0;
		allChecksPassed &&= sessionChecksPassed;
		checks.push({
			nativeSessionId: sessionRef.nativeSessionId,
			transcriptPath: sessionRef.transcriptPath,
			transcriptIsReadable,
			launchArgvTemplateIsComplete: templateIsComplete,
			forbiddenExtraArgs,
			passed: sessionChecksPassed,
		});
	}
	return allChecksPassed
		? success({ ok: true, checks })
		: { exitCode: 1, output: JSON.stringify({ ok: false, checks }, null, "\t") };
}

export async function runAgentConversationExplorationThreadGraphCli(
	argv: readonly string[],
): Promise<AgentConversationExplorationThreadGraphCliResult> {
	const [subcommand, ...subcommandArgv] = argv;
	const usage = renderAgentConversationExplorationThreadGraphCliUsage();
	if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
		return { exitCode: 0, output: usage };
	}
	const parsed = parseCliArguments(subcommandArgv);
	switch (subcommand) {
		case "maintain":
			return await runMaintainSubcommand(parsed);
		case "get":
			return await runGetSubcommand(parsed);
		case "schema":
			return success(buildExplorationThreadGraphMaintenanceProposalJsonSchema());
		case "doctor":
			return await runDoctorSubcommand(parsed);
		default:
			return { exitCode: 2, output: `未知子命令：${subcommand}\n\n${usage}` };
	}
}

const isInvokedAsExecutable =
	process.argv[1] !== undefined && /agent-conversation-exploration-thread-graph-cli\.[cm]?js$/.test(process.argv[1]);
if (isInvokedAsExecutable) {
	const { exitCode, output } = await runAgentConversationExplorationThreadGraphCli(process.argv.slice(2));
	process.stdout.write(`${output}\n`);
	process.exitCode = exitCode;
}
