// doctor 的完整性（handoff A.7，RVF-013）：除了 transcript 可读与 fork 参数模板完整，
// 还必须探测 `claude` 是否真的可执行——doctor 存在的意义就是在昂贵的 maintain 之前发现这件事，
// 否则机器上没装 claude 时 doctor 照样报通过，直到 maintain 在 spawn 处才失败。

import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentConversationExplorationThreadGraphCli } from "../../src/cli/agent-conversation-exploration-thread-graph-cli.js";
import { createFakeClaudeExecutableDirectory } from "../fixtures/exploration-thread-graph-test-doubles.js";

const fixtureTranscriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"claude-code-transcript-desensitized.jsonl",
);

let workspaceDirectory = "";
let transcriptPath = "";
let originalSearchPath: string | undefined;

beforeEach(async () => {
	workspaceDirectory = await mkdtemp(join(tmpdir(), "cli-doctor-test-"));
	transcriptPath = join(workspaceDirectory, "session-fixture.jsonl");
	await copyFile(fixtureTranscriptPath, transcriptPath);
	originalSearchPath = process.env.PATH;
});

afterEach(() => {
	process.env.PATH = originalSearchPath;
});

function buildCompleteSessionJson(): string {
	return JSON.stringify({
		harnessKind: "claude_code",
		nativeSessionId: "session-fixture",
		transcriptPath,
		workingDirectory: workspaceDirectory,
		launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
	});
}

interface DoctorOutputPayload {
	ok: unknown;
	checks: Record<string, unknown>[];
}

async function runDoctorWithSessionJson(sessionJsonText: string): Promise<{
	exitCode: number;
	payload: DoctorOutputPayload;
}> {
	const result = await runAgentConversationExplorationThreadGraphCli(["doctor", "--session", sessionJsonText]);
	return { exitCode: result.exitCode, payload: JSON.parse(result.output) as DoctorOutputPayload };
}

/** 造一个假的 `claude`，并让它成为 PATH 上唯一能被找到的那个。 */
async function installFakeClaudeExecutableAsOnlyOneOnSearchPath(): Promise<string> {
	const fakeExecutableDirectory = await createFakeClaudeExecutableDirectory(workspaceDirectory);
	process.env.PATH = fakeExecutableDirectory;
	return join(fakeExecutableDirectory, "claude");
}

describe("doctor 的 claude 可执行性探测（RVF-013）", () => {
	it("PATH 上找不到 claude 时该会话判为不通过", async () => {
		process.env.PATH = join(workspaceDirectory, "definitely-not-a-real-bin-directory");
		const { exitCode, payload } = await runDoctorWithSessionJson(buildCompleteSessionJson());
		expect(payload.checks[0]?.transcriptIsReadable).toBe(true);
		expect(payload.checks[0]?.launchArgvTemplateIsComplete).toBe(true);
		expect(payload.checks[0]?.claudeExecutableIsResolvable).toBe(false);
		expect(payload.checks[0]?.claudeExecutableResolvedPath).toBeNull();
		expect(payload.checks[0]?.passed).toBe(false);
		expect(payload.ok).toBe(false);
		expect(exitCode).toBe(1);
	});

	it("PATH 上有可执行的 claude 时通过并回报解析到的路径", async () => {
		const fakeExecutablePath = await installFakeClaudeExecutableAsOnlyOneOnSearchPath();
		const { exitCode, payload } = await runDoctorWithSessionJson(buildCompleteSessionJson());
		expect(payload.checks[0]?.claudeExecutableIsResolvable).toBe(true);
		expect(payload.checks[0]?.claudeExecutableResolvedPath).toBe(fakeExecutablePath);
		expect(payload.checks[0]?.passed).toBe(true);
		expect(exitCode).toBe(0);
	});

	it("同名目录不算可执行文件（PATH 上撞到目录时不能误判为找到）", async () => {
		const binDirectory = join(workspaceDirectory, "bin-with-directory-named-claude");
		await mkdir(join(binDirectory, "claude"), { recursive: true });
		process.env.PATH = binDirectory;
		const { payload } = await runDoctorWithSessionJson(buildCompleteSessionJson());
		expect(payload.checks[0]?.claudeExecutableIsResolvable).toBe(false);
	});

	it("非 claude_code 会话不做可执行性探测，照旧只留说明", async () => {
		process.env.PATH = join(workspaceDirectory, "definitely-not-a-real-bin-directory");
		const { exitCode, payload } = await runDoctorWithSessionJson(
			JSON.stringify({ harnessKind: "dsh", nativeSessionId: "dsh-session" }),
		);
		expect(payload.checks[0]?.claudeExecutableIsResolvable).toBeUndefined();
		expect(exitCode).toBe(0);
	});
});
