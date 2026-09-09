import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_CLI_SUBCOMMAND_NAMES,
	runAgentConversationExplorationThreadGraphCli,
} from "../src/cli/agent-conversation-exploration-thread-graph-cli.js";
import {
	AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME,
	EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION,
} from "../src/core/index.js";
import { DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY } from "../src/dsh-plugin/index.js";
import { CLAUDE_CODE_HARNESS_KIND } from "../src/harness-claude-code/index.js";
import { CODEX_HARNESS_KIND } from "../src/harness-codex/index.js";

const repositoryRootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("package 入口点 smoke", () => {
	it("core 导出契约常量（A.13）", () => {
		expect(EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION).toBe(1);
		expect(AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV_VARIABLE_NAME).toBe(
			"AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB",
		);
	});

	it("harness 与 dsh 入口导出判别常量", () => {
		expect(CLAUDE_CODE_HARNESS_KIND).toBe("claude_code");
		expect(CODEX_HARNESS_KIND).toBe("codex");
		expect(DSH_EXPLORATION_THREAD_GRAPH_PROJECTION_KEY).toBe("explorationThreadGraph");
	});

	it("CLI 无参数输出用法、未知子命令 exit 2", () => {
		expect(runAgentConversationExplorationThreadGraphCli([]).exitCode).toBe(0);
		expect(runAgentConversationExplorationThreadGraphCli(["nope"]).exitCode).toBe(2);
		for (const name of AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_CLI_SUBCOMMAND_NAMES) {
			expect(runAgentConversationExplorationThreadGraphCli([]).output).toContain(name);
		}
	});

	it("package.json exports 的每个子路径都对应一个存在的 src 源文件", async () => {
		const packageJson = JSON.parse(await readFile(path.join(repositoryRootDirectory, "package.json"), "utf8")) as {
			exports: Record<string, { import: string }>;
			bin: Record<string, string>;
		};
		const distToSourcePath = (distPath: string): string =>
			path.join(
				repositoryRootDirectory,
				distPath
					.replace(/^\.\//, "")
					.replace(/^dist\//, "src/")
					.replace(/\.js$/, ".ts"),
			);
		const expectedSubpaths = ["./core", "./harness-claude-code", "./harness-codex", "./cli", "./dsh-plugin"];
		expect(Object.keys(packageJson.exports).sort()).toEqual([...expectedSubpaths].sort());
		for (const subpath of expectedSubpaths) {
			const entry = packageJson.exports[subpath];
			if (entry === undefined) {
				throw new Error(`package.json exports 缺少子路径 ${subpath}`);
			}
			await expect(access(distToSourcePath(entry.import))).resolves.toBeUndefined();
		}
		const binDistPath = packageJson.bin["agent-conversation-exploration-thread-graph"];
		if (binDistPath === undefined) {
			throw new Error("package.json bin 缺少 agent-conversation-exploration-thread-graph");
		}
		await expect(access(distToSourcePath(binDistPath))).resolves.toBeUndefined();
	});
});
