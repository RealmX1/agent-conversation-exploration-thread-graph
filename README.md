# agent-conversation-exploration-thread-graph

把「一次 agent 会话探索场次」建模为 **git-graph 语义的 thread graph**：thread = 分支（lane），turn = 提交，多对一关系边 = merge。由**主会话 fork 出的 work-branch 作业**在每个 turn 结束后判定归属并维护，产出给任何宿主渲染的 projection 整值。

- 零宿主依赖的核心库 + 各 harness 适配器 + CLI；UI 渲染壳由宿主自己做。
- 第一宿主：[cline-kanban](https://github.com/RealmX1/cline-kanban)（经 `github:` git 依赖引用本包）。
- 目标宿主：DeepSeek Harness（dsh）插件（`/dsh-plugin` 入口）。
- 术语表见 `CONTEXT.md`；完整计划、接口与契约见 `.plan/docs/exploration-thread-graph-core-handoff.md`。

## 状态

R0 脚手架：包布局、构建、检查链与入口点占位已就绪，`npm run check` 全绿；领域实现按 handoff 的 R1 → R4 推进。

## 三层架构（依赖方向单向）

```
┌──────────────── 宿主胶水（host glue，不在本仓库）────────────────┐
│ cline-kanban：会话身份捕获 / Stop 触发 / WS 广播 / Focus View 面板 │
│ dsh 插件：turn 事件触发 / fork-in-process / projection / tab      │
└──────────────▲────────────────────────────────────────────────┘
               │ import（npm 包子路径）
┌──────────────┴──── harness 适配器 ──────────────────────────────┐
│ /harness-claude-code：transcript JSONL 投影 + `claude -p --resume --fork-session` 执行器 │
│ /harness-codex：rollout 投影 + `codex exec resume` 执行器（可选）                    │
└──────────────▲────────────────────────────────────────────────┘
               │
┌──────────────┴──── 核心 /core（零宿主依赖）──────────────────────┐
│ 领域 schema（zod）/ 文件 store / apply 漏斗（唯一写点）/ 维护作业       │
│ projection view（整值）/ lane 布局（纯函数）/ CLI（/cli）              │
└────────────────────────────────────────────────────────────────┘
```

核心只认两个接口：**CompletedTurnSequenceSource**（某 harness 的「已完成 turn 序列」来源）与 **ForkedWorkBranchExecutor**（以父会话为种子、要求结构化输出的 fork 调用）。两者的形状镜像 dsh 的 session 日志与 `subagent-fork-in-process` seam，所以同一份核心既能挂在 cline-kanban 上，也能挂成 dsh 插件。

## 包入口

| 子路径 | 内容 |
| --- | --- |
| `agent-conversation-exploration-thread-graph/core` | schema、store、apply 漏斗、维护作业、projection view、lane 布局 |
| `agent-conversation-exploration-thread-graph/harness-claude-code` | Claude Code transcript 投影 + fork 执行器 |
| `agent-conversation-exploration-thread-graph/harness-codex` | Codex rollout 投影 + 执行器（可选） |
| `agent-conversation-exploration-thread-graph/cli` | `maintain / get / schema / doctor` |
| `agent-conversation-exploration-thread-graph/dsh-plugin` | dsh Cordis 插件 `apply(ctx)` |

bin：`agent-conversation-exploration-thread-graph <subcommand>`。

## 开发

```bash
npm ci            # 装依赖并经 prepare 构建 dist/
npm run check     # biome + typecheck + vitest
npm run build     # tsc -p tsconfig.build.json → dist/
```

要求 Node ≥ 22。无 lockfile 时 `npm install` 请用 npm ≥ 11（npm 10.9.8 的依赖解析在 vitest 4 peer 集上会崩）；有 lockfile 后 `npm ci` 在 npm 10.9.8 也正常。

## 作为依赖使用

```jsonc
// 消费方 package.json
"dependencies": {
	"agent-conversation-exploration-thread-graph": "github:RealmX1/agent-conversation-exploration-thread-graph#<commit-sha>"
}
```

安装时 npm 会 clone、装 devDependencies 并跑 `prepare`（`tsc` 构建 `dist/`），不需要发布到 npm。本地联调：在本仓库 `npm link`，在消费方 `npm link agent-conversation-exploration-thread-graph`。

## 裸用法（无 Kanban，规划中）

在 `~/.claude/settings.json` 里给 Stop hook 挂一条命令：

```bash
agent-conversation-exploration-thread-graph maintain \
	--exploration-id <根会话 session id> \
	--store-root ~/.agent-conversation-exploration-thread-graph \
	--session '<ConversationSessionRef JSON>' \
	--mode incremental
```

然后 `agent-conversation-exploration-thread-graph get --exploration-id <id> --store-root <dir> --view` 输出 projection 整值。子命令的完整参数见 handoff A.7。

## 与宿主的契约

与 cline-kanban 的共享真相是 handoff 的 A.13：宿主提供 `explorationId`、`sessions[]`（含 `launchArgvTemplate`）、`storeRoot` 与触发时机；本包保证 fork 进程 env 含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`、只写 `storeRoot`、所有写入经漏斗、回报 prompt cache 读量。改 schema 必 bump `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION` 并记 `CHANGELOG.md`；宿主升级 = 换 commit SHA。
