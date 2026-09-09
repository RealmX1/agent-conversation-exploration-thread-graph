#!/usr/bin/env node
// bin `agent-conversation-exploration-thread-graph`：maintain / get / schema / doctor（handoff A.7）。
// R0 阶段只有子命令清单与用法输出；R3 接线到核心作业。

/** 计划中的子命令名清单；R3 逐个接线，接线前调用一律返回 exit code 2 与用法。 */
export const AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_CLI_SUBCOMMAND_NAMES = [
	"maintain",
	"get",
	"schema",
	"doctor",
] as const;

export type AgentConversationExplorationThreadGraphCliSubcommandName =
	(typeof AGENT_CONVERSATION_EXPLORATION_THREAD_GRAPH_CLI_SUBCOMMAND_NAMES)[number];

export function renderAgentConversationExplorationThreadGraphCliUsage(): string {
	return [
		"用法：agent-conversation-exploration-thread-graph <subcommand> [options]",
		"",
		"子命令：",
		"  maintain   对一个 exploration 跑一次 work-branch 维护作业（--exploration-id --store-root --session --mode）",
		"  get        输出 exploration 的 collection 或 projection view（--exploration-id --store-root [--view]）",
		"  schema     输出维护作业 proposal 的 JSON Schema",
		"  doctor     检查会话引用：transcript 可读、harness CLI 可执行、fork 参数模板完整（--session）",
		"",
		"当前状态：R0 脚手架，子命令尚未接线。",
	].join("\n");
}

export function runAgentConversationExplorationThreadGraphCli(argv: readonly string[]): {
	exitCode: number;
	output: string;
} {
	const [subcommand] = argv;
	const usage = renderAgentConversationExplorationThreadGraphCliUsage();
	if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
		return { exitCode: 0, output: usage };
	}
	return { exitCode: 2, output: `未知或尚未接线的子命令：${subcommand}\n\n${usage}` };
}

const isInvokedAsExecutable =
	process.argv[1] !== undefined && /agent-conversation-exploration-thread-graph-cli\.[cm]?js$/.test(process.argv[1]);
if (isInvokedAsExecutable) {
	const { exitCode, output } = runAgentConversationExplorationThreadGraphCli(process.argv.slice(2));
	process.stdout.write(`${output}\n`);
	process.exitCode = exitCode;
}
