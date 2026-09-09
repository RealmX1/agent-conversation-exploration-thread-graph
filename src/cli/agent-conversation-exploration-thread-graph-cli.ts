#!/usr/bin/env node
// bin `agent-conversation-exploration-thread-graph`：maintain / get / schema / doctor（handoff A.7）。
//
// 形状纪律：子命令一律是**返回 `{exitCode, output}` 的纯函数**，只有文件末尾的可执行守卫写 stdout。
// 这样 CLI 的每条路径都能在单测里直接断言，不必去捞进程输出。

import { access, constants, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
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
	DEFAULT_CLAUDE_EXECUTABLE_PATH,
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
		"  doctor     检查会话引用：transcript 可读、`claude` 可执行、fork 参数模板完整 --session <json>",
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

/** `--session` 里的 claude_code 分支；doctor 与结构校验都按它逐字段核对。 */
type ClaudeCodeConversationSessionRef = Extract<ConversationSessionRef, { harnessKind: "claude_code" }>;

type ClaudeCodeLaunchArgvTemplate = ClaudeCodeConversationSessionRef["launchArgvTemplate"];

function describeInvalidSessionField(fieldPath: string, expectation: string, actualValue: unknown): string {
	const renderedActualValue = actualValue === undefined ? "undefined" : JSON.stringify(actualValue);
	return `--session 的 ${fieldPath} ${expectation}，收到 ${renderedActualValue}`;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

/**
 * 校验 claude_code 会话的 fork 参数模板。宿主漏字段时必须在这里被挡住：
 * 放进去的话，错误会以 TypeError 的形态在 doctor / maintain 内部炸开，而不是 CLI 约定的 exit 2。
 */
function validateClaudeCodeLaunchArgvTemplateShape(value: unknown): ClaudeCodeLaunchArgvTemplate | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return describeInvalidSessionField(
			"launchArgvTemplate",
			"必须是含 model / appendSystemPrompt / settingsPath / extraArgs 的 JSON 对象",
			value,
		);
	}
	const candidateTemplate = value as Record<string, unknown>;
	const { model, appendSystemPrompt, settingsPath, extraArgs } = candidateTemplate;
	if (!isNonEmptyString(model)) {
		return describeInvalidSessionField("launchArgvTemplate.model", "必须是非空字符串（argv 字面值）", model);
	}
	if (!isStringOrNull(appendSystemPrompt)) {
		return describeInvalidSessionField(
			"launchArgvTemplate.appendSystemPrompt",
			"必须是字符串或 null",
			appendSystemPrompt,
		);
	}
	if (!isStringOrNull(settingsPath)) {
		return describeInvalidSessionField("launchArgvTemplate.settingsPath", "必须是字符串或 null", settingsPath);
	}
	if (!Array.isArray(extraArgs)) {
		return describeInvalidSessionField("launchArgvTemplate.extraArgs", "必须是字符串数组", extraArgs);
	}
	const validatedExtraArgs: string[] = [];
	for (const extraArgument of extraArgs as unknown[]) {
		if (typeof extraArgument !== "string") {
			return describeInvalidSessionField("launchArgvTemplate.extraArgs", "的每一项都必须是字符串", extraArgument);
		}
		validatedExtraArgs.push(extraArgument);
	}
	return { model, appendSystemPrompt, settingsPath, extraArgs: validatedExtraArgs };
}

/** 分叉锚点是可选字段：缺席返回 null，出现但不是正整数则返回错误串。 */
function validateOptionalForkedFromParentSessionTurnNumber(value: unknown): number | null | string {
	if (value === undefined) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return describeInvalidSessionField("forkedFromParentSessionTurnNumber", "必须是正整数", value);
	}
	return value;
}

/**
 * 把外部传入的 `--session` JSON 逐字段校验成 `ConversationSessionRef`。
 *
 * 刻意**显式构造**返回值而不是断言：`ConversationSessionRef` 将来加必填字段时，这里会由 tsc 报错，
 * 校验不会悄悄落后于类型。
 */
function validateConversationSessionRefShape(candidate: Record<string, unknown>): ConversationSessionRef | string {
	const { harnessKind } = candidate;
	if (harnessKind !== "claude_code" && harnessKind !== "codex" && harnessKind !== "dsh") {
		return `--session 的 harnessKind 不认识：${String(harnessKind)}`;
	}
	const { nativeSessionId } = candidate;
	if (!isNonEmptyString(nativeSessionId)) {
		return describeInvalidSessionField("nativeSessionId", "必须是非空字符串", nativeSessionId);
	}
	const forkAnchorOrError = validateOptionalForkedFromParentSessionTurnNumber(
		candidate.forkedFromParentSessionTurnNumber,
	);
	if (typeof forkAnchorOrError === "string") return forkAnchorOrError;
	// exactOptionalPropertyTypes 开着：缺席的可选字段必须整个不出现，不能写成 undefined。
	const optionalForkAnchor =
		forkAnchorOrError === null ? {} : { forkedFromParentSessionTurnNumber: forkAnchorOrError };

	if (harnessKind === "dsh") {
		return { harnessKind, nativeSessionId, ...optionalForkAnchor };
	}
	const { workingDirectory } = candidate;
	if (!isNonEmptyString(workingDirectory)) {
		return describeInvalidSessionField("workingDirectory", "必须是非空字符串", workingDirectory);
	}
	if (harnessKind === "codex") {
		const { rolloutPath } = candidate;
		if (!isNonEmptyString(rolloutPath)) {
			return describeInvalidSessionField("rolloutPath", "必须是非空字符串", rolloutPath);
		}
		return { harnessKind, nativeSessionId, rolloutPath, workingDirectory, ...optionalForkAnchor };
	}
	const { transcriptPath } = candidate;
	if (!isNonEmptyString(transcriptPath)) {
		return describeInvalidSessionField("transcriptPath", "必须是非空字符串", transcriptPath);
	}
	const launchArgvTemplateOrError = validateClaudeCodeLaunchArgvTemplateShape(candidate.launchArgvTemplate);
	if (typeof launchArgvTemplateOrError === "string") return launchArgvTemplateOrError;
	return {
		harnessKind,
		nativeSessionId,
		transcriptPath,
		workingDirectory,
		launchArgvTemplate: launchArgvTemplateOrError,
		...optionalForkAnchor,
	};
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
		const sessionRefOrError = validateConversationSessionRefShape(parsedSession as Record<string, unknown>);
		if (typeof sessionRefOrError === "string") return sessionRefOrError;
		sessionRefs.push(sessionRefOrError);
	}
	return sessionRefs;
}

/**
 * `setTimeout` 能表达的最大毫秒数（32 位有符号上限）。超过它 Node 会把延时**压回 1ms**，
 * 症状与 NaN 一模一样——分身刚起来就被 SIGTERM 秒杀——所以一并挡在 CLI 边界。
 */
const MAXIMUM_SUPPORTED_FORK_TIMEOUT_MILLISECONDS = 2_147_483_647;

/**
 * 把数值型参数解析成正整数。刻意用 `Number` 而不是 `Number.parseInt`：
 * 后者会把 `abc` 悄悄变成 NaN、把 `12abc` 悄悄变成 12，两种都会让作业带着垃圾值白跑一趟
 * （NaN 批量 = 空判定列表却照样烧一次全价 fork；NaN 超时 = setTimeout 立刻杀掉分身）。
 */
function parsePositiveIntegerFlag(flagName: string, rawText: string, maximumValue: number): number | string {
	const parsedValue = Number(rawText.trim());
	if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
		return `${flagName} 必须是正整数，收到 ${JSON.stringify(rawText)}`;
	}
	if (parsedValue > maximumValue) {
		return `${flagName} 不能超过 ${maximumValue}，收到 ${JSON.stringify(rawText)}`;
	}
	return parsedValue;
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

	// 数值参数先于会话解析校验：它们是纯字符串检查，最便宜，而 resolveSessionRefs 还要读文件。
	const batchSizeText = readSingleFlag(parsed, "batch-size");
	const batchSizeOrError =
		batchSizeText === null ? null : parsePositiveIntegerFlag("--batch-size", batchSizeText, Number.MAX_SAFE_INTEGER);
	if (typeof batchSizeOrError === "string") return failure(batchSizeOrError);
	const timeoutText = readSingleFlag(parsed, "timeout-ms");
	const timeoutMillisecondsOrError =
		timeoutText === null
			? null
			: parsePositiveIntegerFlag("--timeout-ms", timeoutText, MAXIMUM_SUPPORTED_FORK_TIMEOUT_MILLISECONDS);
	if (typeof timeoutMillisecondsOrError === "string") return failure(timeoutMillisecondsOrError);

	const sessionRefsOrError = await resolveSessionRefs(parsed);
	if (typeof sessionRefsOrError === "string") return failure(sessionRefsOrError);

	const overrideModel = readSingleFlag(parsed, "model");

	const result = await runExplorationThreadGraphMaintenanceJob({
		explorationId,
		sessions: sessionRefsOrError,
		turnSource: new ClaudeCodeTranscriptCompletedTurnSource({
			treatFinalTurnAsCompleted: parsed.booleanFlags.has("final-turn-completed"),
		}),
		executor: new ClaudeCodeForkedSessionWorkBranchExecutor(overrideModel === null ? {} : { overrideModel }),
		storeRoot,
		mode,
		...(batchSizeOrError === null ? {} : { batchSize: batchSizeOrError }),
		...(timeoutMillisecondsOrError === null ? {} : { timeoutMs: timeoutMillisecondsOrError }),
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

/**
 * `claude` 可执行性探测（handoff A.7 的第二项）。
 *
 * 刻意只做 PATH 解析而**不**真的起进程：doctor 是 maintain 之前的廉价前置检查，
 * 起一次 `claude --version` 就要几百毫秒且会读用户配置，不值当。
 * 任何 I/O 异常都吞掉当作「不可执行」——探测失败绝不能让 doctor 自己崩溃。
 */
async function isExecutableRegularFile(candidatePath: string): Promise<boolean> {
	try {
		const candidateStat = await stat(candidatePath);
		if (!candidateStat.isFile()) return false;
		await access(candidatePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** 按 PATH 解析可执行文件；带路径分隔符的写法当成路径本身，不查 PATH。找不到返回 null。 */
async function resolveExecutablePathOnSearchPath(executablePath: string): Promise<string | null> {
	if (isAbsolute(executablePath) || executablePath.includes(sep) || executablePath.includes("/")) {
		return (await isExecutableRegularFile(executablePath)) ? executablePath : null;
	}
	const searchDirectories = (process.env.PATH ?? "").split(delimiter).filter((directory) => directory !== "");
	for (const searchDirectory of searchDirectories) {
		const candidatePath = join(searchDirectory, executablePath);
		if (await isExecutableRegularFile(candidatePath)) return candidatePath;
	}
	return null;
}

async function runDoctorSubcommand(
	parsed: ParsedCliArguments,
): Promise<AgentConversationExplorationThreadGraphCliResult> {
	const sessionRefsOrError = await resolveSessionRefs(parsed);
	if (typeof sessionRefsOrError === "string") return failure(sessionRefsOrError);

	// `claude` 在不在是**机器层面**的事实，与会话无关：整轮只探一次，再摊进每个 claude_code 会话的结论。
	const hasClaudeCodeSession = sessionRefsOrError.some((sessionRef) => sessionRef.harnessKind === "claude_code");
	const claudeExecutableResolvedPath = hasClaudeCodeSession
		? await resolveExecutablePathOnSearchPath(DEFAULT_CLAUDE_EXECUTABLE_PATH)
		: null;

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
		const claudeExecutableIsResolvable = claudeExecutableResolvedPath !== null;
		const sessionChecksPassed =
			transcriptIsReadable && templateIsComplete && forbiddenExtraArgs.length === 0 && claudeExecutableIsResolvable;
		allChecksPassed &&= sessionChecksPassed;
		checks.push({
			nativeSessionId: sessionRef.nativeSessionId,
			transcriptPath: sessionRef.transcriptPath,
			transcriptIsReadable,
			launchArgvTemplateIsComplete: templateIsComplete,
			forbiddenExtraArgs,
			claudeExecutableName: DEFAULT_CLAUDE_EXECUTABLE_PATH,
			claudeExecutableIsResolvable,
			claudeExecutableResolvedPath,
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
