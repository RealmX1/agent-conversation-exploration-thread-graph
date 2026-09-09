# exploration-thread-graph 核心库 handoff（Pass A：本仓库内的全部工作）

> 写给在 `~/Documents/GitHub/agent-conversation-exploration-thread-graph` 里接手的 agent。你没有产出本文的那段对话的上下文，本文自足。
> 参考仓库**只读**：cline-kanban `~/Documents/GitHub/cline-kanban`（第一宿主，Exploratory Mode M0–M2 骨架在 main）、dsh `~/Documents/GitHub/deepseek-harness`（目标宿主，接口要镜像的对象）。
> 全程遵守用户全局规则：中文文档 / 注释 / commit；命名过度指定；未经用户要求不 commit、绝不 push；无 `any`；不 inline import；执行顺序自行拓扑排序不问用户，只有会改变最终结果且无明显占优方案的 trade-off 才提问。
> 术语以 `CONTEXT.md` 为准；本仓库承重规则在 `AGENTS.md`。

## 0. 背景：为什么有这个仓库

cline-kanban 的 Exploratory Mode（M0–M2）已落地「session map + findings」，但基座有两个漏洞：功能 Cline-only 而用户 99% 的会话在 PTY（Claude Code / Codex）里；map 是扁平列表，表达不了分支。从零拷问后定案为：**探索场次的 thread graph（git-graph 语义）+ 由主会话 fork 出的 work-branch 作业维护 + PTY 一等公民**。

随后摸底发现 **DeepSeek Harness（dsh）是真正的目标宿主**：它原生具备本系统在宿主侧要造的一切——耐久 `turn/start|end` 事件（turn 编号免费）、`subagent-fork-in-process`（以父会话已完成 turn 前缀为种子、字节一致可复用 KV cache、支持 `outputSchema` 结构化输出）、session-projection seam（宿主纯 fold、客户端收整值）、`conversation.view` slot ring、Claude Code 格式 hooks 桥。但 dsh 处于 developer preview（明示破坏性变更），用户日常探索会话仍在 cline-kanban 的 Claude Code / Codex PTY 里。

所以：**核心独立成仓库，边界按 dsh seam 形状切；第一宿主 cline-kanban；dsh 插件后置但本仓库末尾补 smoke 适配验证边界。**

### 0.1 已拍板决策（不要重开）

| # | 决定 |
|---|---|
| D1 | 目标宿主 PTY-first（Claude Code / Codex）；ACP 未来；Cline 不再考虑 |
| D2 | 最急需 = 实时会话导航中「话题分叉的提炼与可视化」；「会话」= 一次 sit down 的探索场次，与 chat session 数量无关 |
| D3 | thread = 分支（lane，时间性容器）、turn = 提交；v1 one-thread-per-turn；topic 只挂 thread；turn 只有 subject tags；偏离由 fork 分身整体判断 |
| D4 | 关系边多对一（一个 turn 可指向多个先前 turn/thread） |
| D5 | 维护执行者 = 主会话 fork 出的 work branch，吃主会话 prompt cache |
| D6 | PTY 导航面：摘录先行；对话视图二期（dsh 宿主下由 dsh 自带 UI 承担） |
| D7 | 核心独立成仓库，接口按 dsh seam 切：turn 来源 = 「已完成 turn 序列」；作业执行 = 「带 outputSchema 的 fork 调用 → structured」；输出 = projection 整值；UI 只共享纯 lane 布局与视图模型 |
| D8 | 第一宿主 cline-kanban；dsh 插件后置；本仓库末尾补 dsh smoke 适配（projection unit + fork 执行器，无 UI） |
| D9 | 仓库名 `agent-conversation-exploration-thread-graph`；单包多入口；cline-kanban 用 `github:RealmX1/agent-conversation-exploration-thread-graph#<sha>` + `prepare` 构建；本地 `npm link` |

### 0.2 三层架构（依赖方向单向）

```
┌──────────────── 宿主胶水（host glue）────────────────┐
│ cline-kanban：身份捕获 / Stop 触发 / WS / Focus View 面板 │  ← cline-kanban 任务 b04a4（Pass B，不在本仓库）
│ dsh 插件：turn 事件触发 / fork-in-process / projection / tab │  ← 后置（smoke 在本仓库 R4）
└──────────────▲───────────────────────────────────────┘
               │ import（npm 包）
┌──────────────┴──── harness 适配器 ────────────────────┐
│ /harness-claude-code：transcript JSONL 投影 + `claude -p --resume --fork-session` 执行器 │
│ /harness-codex：rollout 投影 + `codex exec resume` 执行器（R3 可选，副作用待核）      │
└──────────────▲───────────────────────────────────────┘
               │
┌──────────────┴──── 核心（/core，零宿主依赖）───────────┐
│ 领域 schema（zod）/ store / apply 漏斗 / 维护作业（prompt + json-schema + 结果解释）│
│ projection view（整值）/ lane 布局（纯函数）/ CLI（/cli）                          │
└──────────────────────────────────────────────────────┘
```

切分理由：transcript 投影与 `claude -p` fork 执行器是 **Claude Code harness 特性**而非 Kanban 特性（无 Kanban 时用全局 Stop hook 也能驱动），所以进本仓库；只有「哪个 Kanban 卡片 = 哪个 exploration、哪些 session 属于它、Stop 何时到、面板挂哪」是 Kanban 胶水。

### 0.3 两个 pass 与交接点

| 阶段 | Pass A（本仓库） | Pass B（cline-kanban b04a4） |
|---|---|---|
| 并行期 | R0 脚手架（**已完成**）→ R1 core → R2 claude harness → R3 作业 + CLI | 原生会话身份捕获；删旧 map 链；指令改探索礼仪；hooks 的作业 env 短路 + PreToolUse deny |
| 交接点 1 | 打 tag `v0.1.0`（由用户执行或明示授权），给出 commit SHA；`/core` `/harness-claude-code` API 冻结 | 加依赖、触发胶水、WS、trpc、面板 |
| 交接点 2 | R4 dsh smoke 适配 | 验证与收尾 |

契约（A.13）是两个 pass 唯一的共享真相；任何一方要改契约，先改 A.13 再改代码。

---

## A.0 使命与非目标

**使命**：把「一次 agent 会话探索场次」建模为 git-graph 语义的 thread graph（thread = 分支/lane，turn = 提交，多对一关系边 = merge），由**主会话 fork 出的 work-branch 作业**在每个 turn 结束后判定归属并维护，产出给任何宿主渲染的 projection 整值。首个宿主 cline-kanban，目标宿主 dsh 插件。

**非目标（v1）**：不做 UI 渲染壳（宿主做）；不做跨 exploration 的 topic 图视图（预留 `topicId` 复用即可）；不做 Cline / ACP 适配；不做 transcript 对话视图；不做 findings 存储（宿主 cline-kanban 已有，本包只在事件标注里携带 `finding_candidate`）。

## A.1 术语表

已落为根目录 `CONTEXT.md`（只放术语不放实现）。改术语先改它。

## A.2 包布局（单包多入口，ESM）

```
agent-conversation-exploration-thread-graph/
├── package.json            # 已就绪：type module；engines node>=22；exports / bin / prepare = build
├── tsconfig.json / tsconfig.build.json（NodeNext；emit 到 dist/，declaration on）
├── biome.json（tab / indentWidth 3 / lineWidth 120；钉 2.5.12）
├── vitest.config.ts（test/**/*.test.ts）
├── AGENTS.md / CONTEXT.md / README.md / CHANGELOG.md（中文）
├── .plan/docs/exploration-thread-graph-core-handoff.md（本文）
├── src/
│   ├── core/
│   │   ├── index.ts                                   # 子路径 ./core 入口（R0 只有契约常量）
│   │   ├── exploration-thread-graph-schema.ts         # zod：A.4 全部实体 + collection + SCHEMA_VERSION
│   │   ├── exploration-thread-graph-store.ts          # 文件 store（串行写队列/原子写/损坏容错/路径守卫/cap）
│   │   ├── exploration-thread-graph-apply-funnel.ts   # 唯一写点，A.5 闸序
│   │   ├── completed-turn-sequence-source.ts          # 接口 + 类型（A.3）
│   │   ├── forked-work-branch-executor.ts             # 接口 + 类型（A.3）
│   │   ├── maintenance-job/
│   │   │   ├── exploration-thread-graph-maintenance-job.ts        # 编排：模式选择 → prompt → 执行 → 校验 → 漏斗
│   │   │   ├── maintenance-job-prompt-assembly.ts                 # A.5 prompt + turn 对照表
│   │   │   ├── maintenance-job-output-json-schema.ts              # zod → JSON Schema（结构化输出契约）
│   │   │   └── maintenance-job-proposal-schema.ts                 # 分身输出的 zod（proposal）
│   │   ├── exploration-thread-graph-projection-view.ts # collection + turns → ProjectionView 整值
│   │   └── thread-graph-lane-layout.ts                 # 纯 lane 布局（移植 cline-kanban buildGraph）
│   ├── harness-claude-code/
│   │   ├── index.ts
│   │   ├── claude-code-transcript-completed-turn-source.ts   # JSONL 增量投影
│   │   ├── claude-code-transcript-record-classifier.ts       # 边界判别（isSidechain/isMeta/tool_result-only/promptSource/origin）
│   │   ├── claude-code-forked-session-work-branch-executor.ts # `claude -p --resume --fork-session --json-schema`
│   │   └── bounded-json-lines-reader.ts                       # 移植自 cline-kanban
│   ├── harness-codex/（R3 可选）
│   ├── cli/
│   │   └── agent-conversation-exploration-thread-graph-cli.ts  # maintain / get / schema / doctor
│   └── dsh-plugin/（R4 smoke）
│       └── index.ts                                            # export apply(ctx)
└── test/（与 src 平行；fixtures/ 放脱敏 transcript）
```

`exports`：`"./core"`, `"./harness-claude-code"`, `"./harness-codex"`, `"./cli"`, `"./dsh-plugin"`；`"bin"`: `agent-conversation-exploration-thread-graph` → `dist/cli/agent-conversation-exploration-thread-graph-cli.js`。`prepare` = `tsc -p tsconfig.build.json`（git 依赖安装时自动编译，不提交 dist）。`test/package-entry-points-smoke.test.ts` 会校验 exports 每个子路径都对应存在的 src 文件——改布局时同步改它。

## A.3 核心接口（镜像 dsh seam；命名过度指定）

```ts
// ── turn 来源（镜像 dsh 会话日志 turn/start|end + user/message.source）
interface CompletedConversationTurn {
	turnNumber: number;                 // 从 1 起，单调
	userPromptExcerpt: string;          // ≤400
	assistantResponseExcerpt: string;   // ≤400，最后一段 text block
	startedAt: string; endedAt: string;
	userMessageOrigin: "human_typed" | "harness_injected";   // 注入类（skill 内容、hook 提醒）不算边界，但保留可见
	toolCallCount: number;
}
interface CompletedTurnSequenceSnapshot {
	conversationSessionId: string;
	sourceKind: "claude_code_transcript" | "codex_rollout" | "dsh_session_log";
	turns: CompletedConversationTurn[];
	sourceSignature: string;            // claude: `${mtimeMs}:${size}:${offset}`；变则重算
	projectionConfidence: "authoritative" | "transcript_reconstructed";
	inProgressTurnNumber: number | null; // 末 turn 未闭合时 = 其编号，不进 turns
}
interface CompletedTurnSequenceSource {
	readCompletedTurnSequence(sessionRef: ConversationSessionRef): Promise<CompletedTurnSequenceSnapshot>;
}

// ── fork 执行器（镜像 dsh SubagentStartRequest.outputSchema → SubagentResult.structured）
interface ForkedWorkBranchRequest {
	parentSession: ConversationSessionRef;
	promptText: string;
	outputSchema: ObjectJsonSchema;      // object-rooted JSON Schema
	timeoutMs: number; signal?: AbortSignal;
}
interface ForkedWorkBranchResult {
	structured?: unknown;                // 满足 outputSchema 时存在
	outputText: string;
	stopReason: "completed" | "error" | "timeout" | "cancelled";
	usage?: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number; costUsd?: number };
	forkedNativeSessionId?: string;      // 审计用，不删 jsonl
}
interface ForkedWorkBranchExecutor { start(req: ForkedWorkBranchRequest): Promise<ForkedWorkBranchResult>; }

// ── 宿主传入的会话引用（各 harness 自己的字段）
type ConversationSessionRef =
	| { harnessKind: "claude_code"; nativeSessionId: string; transcriptPath: string; workingDirectory: string;
	    launchArgvTemplate: { model: string; appendSystemPrompt: string | null; settingsPath: string | null; extraArgs: string[] };
	    forkedFromParentSessionTurnNumber?: number }
	| { harnessKind: "codex"; nativeSessionId: string; rolloutPath: string; workingDirectory: string; /* R3 补 */ }
	| { harnessKind: "dsh"; nativeSessionId: string };

// ── store / 漏斗 / 视图 / 布局（R1 落地后的最终签名）
readExplorationThreadGraphCollection(storeRoot, explorationId, now?) / readExplorationTopicRegistry(storeRoot)
mutateExplorationThreadGraph(storeRoot, explorationId, mutator, now?)   // collection 与 topic 注册表同锁落盘；durable-write-before-ack
applyExplorationThreadGraphMaintenanceProposal({
  explorationId, proposal /* 未校验，闸 1 在漏斗内做 */, turnSnapshotsBySession,
  proposalSourceTurnSequenceSignatureBySession,   // 作业发起时读到的签名，闸 8 拿它对账
  currentCollection, currentTopicRegistry,        // 漏斗要跨两者派生 id / 复用 topic
  revisionWindowTurnCount?, maintenanceJobUsage?, now,
}) → { outcome: "accepted"; collection; topicRegistry }
  | { outcome: "rejected"; rejectionReason; collectionStaleMarkUpdate }   // 后者非 null 时调用方原样写盘（闸 8 的「拒绝并标 stale」）
buildExplorationThreadGraphProjectionView(collection, turnSnapshotsBySession, topicRegistry) → ExplorationThreadGraphProjectionView
layoutThreadGraphLanes(rows: { id: string; parentIds: string[] }[]) → ThreadGraphLaneLayoutRow[]   // rows 必须**新→旧**（git log 序）
```

**edge 与 parentIds 的映射规则**（视图层固定）：`continues` → 上一 turn；`forks_from` / `returns_to` / `draws_from` → target turn（多条 = 多 parent）；`concludes` → 该 thread 最后一个 turn（画合流线）。
视图层另补两条**隐式** parent，使分身漏发边时 lane 不至于碎成孤点：① 同一 thread 内的上一个 turn 恒为第一 parent；② thread 的首个 turn 接到它的 `forkedFromTurnRef`。自指、以及指向未来的 parent 一律滤掉。
`layoutThreadGraphLanes` 移植自 cline-kanban `buildGraph`，但**不导出 `convergingLanes`**：该实现每行末尾会对泳道去重，因此任何时刻都不会有两条泳道等同一个 id，那个字段恒为空。

## A.4 Schema（zod，`exploration-thread-graph-schema.ts`；`EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION = 1`）

```ts
explorationTurnRef = { conversationSessionId, turnNumber, turnCheckpointCommit: string|null }
explorationTopic   = { topicId, topicTitle(≤80), topicAliases: string[](≤8), topicSummaryMarkdown(≤400|null),
                       supersededByTopicId: string|null, generationSource: "work_branch_maintenance_job"|"user_manual_edit", createdAt, updatedAt }
explorationThread  = { threadId: `thread-<n>`, threadTitle(≤80), parentThreadId: string|null, forkedFromTurnRef: explorationTurnRef|null,
                       primaryTopicId, threadLifecycleStatus: "active"|"concluded"|"parked"|"abandoned",
                       concludedAtTurnRef: explorationTurnRef|null, generationSource, createdAt, updatedAt }
turnThreadPlacement = { turnRef, threadId, placementConfidence: "high"|"low", deviationRationale: string|null, placementSource, createdAt, updatedAt }
turnSubjectTagging  = { turnRef, turnSubjectTags: string[](≤8, 规范化去重), taggingSource, createdAt, updatedAt }
turnRelationEdge    = { sourceTurnRef, edgeKind: "continues"|"forks_from"|"returns_to"|"draws_from"|"concludes", targetTurnRef|null, targetThreadId|null, generationSource, createdAt }
turnEventMark       = { turnRef, mark: "milestone"|"decision_point"|"open_question"|"finding_candidate", note: string|null, externalReferenceId: string|null, generationSource, createdAt }

explorationThreadGraphCollection (per explorationId) = {
  schemaVersion, explorationId,
  threads[], turnThreadPlacements[], turnSubjectTaggings[], turnRelationEdges[], turnEventMarks[],
  sourceTurnSequenceSignatureBySession: Record<sessionId, string>,
  lastPlacedTurnNumberBySession: Record<sessionId, number>,
  staleReason: "new_turns_not_yet_placed"|"turn_source_signature_changed"|null,
  lastMaintenanceJobCompletedAt, lastMaintenanceJobUsage, updatedAt }
topicRegistry (per storeRoot) = { schemaVersion, topics: explorationTopic[] }
```

所有 `createdAt` / `updatedAt` 一律 **epoch 毫秒整数**（`CompletedConversationTurn` 的 `startedAt`/`endedAt` 是 harness 原始 ISO 字符串，两者不要混用）。
边的去重身份 = `source + edgeKind + target`；事件标注的去重身份 = `turnRef + mark`——重跑作业不该长出重复线或重复标注。

文件布局：`<storeRoot>/topic-registry.json`、`<storeRoot>/explorations/<explorationId>/exploration-thread-graph.json`。宿主传 `storeRoot`（cline-kanban 传 `~/.cline/kanban/workspaces/<ws>/agent-conversation-exploration-thread-graph/`；裸 CLI 默认 `~/.agent-conversation-exploration-thread-graph/`）。

## A.5 维护作业与漏斗

**作业输入**：`{ explorationId, sessions: ConversationSessionRef[], turnSource, executor, store, mode: "initial_backfill"|"incremental", revisionWindow: 3, batchSize }`。主会话 = `sessions[0]`（fork 它）；by-the-way 会话的 turn 也在 prompt 里列出，其分叉锚点直接取 `forkedFromParentSessionTurnNumber`，作业只判父级。

**Prompt 组装**（`maintenance-job-prompt-assembly.ts`）：① 角色与目的（你是本会话的分身，只输出 JSON，不执行工具）② 判据文字（偏离定义 + 线索：用户明说换话题 / by-the-way 措辞 / 回到先前某问题 / 新假设展开）③ **turn 对照表**：`turnNumber ↔ 用户消息前 80 字 ↔ 当前 placement（threadId/topic 标题）`，让分身把编号对上自己上下文里的消息 ④ 现有 threads / topics 摘要 ⑤ 待判范围（incremental：frontier 之后 + 修订窗口内；backfill：全部，可分批）⑥ 判断清单（下）⑦ 只输出符合 schema 的 JSON。

**每 turn 判断清单**：① 延续/偏离（偏离必附 `deviationRationale`）② 偏离去向三选一：回归既有 thread[id] / 分叉新 thread[父 + 锚点 turn，默认上一 turn，用户明示「回到 T3」则锚 T3] / 平地起 by-the-way[挂根] ③ 新 thread 父级 ④ 新 thread 命名 + topic（标题 ≤80 + 一句摘要；可复用注册表既有 topic）⑤ 离开 thread 时其状态（`concludes` 边 + status）⑥ 事件标注（可选）⑦ turnSubjectTags（多主题即多标签）⑧ 置信度。每次运行必做 ⑫ 复核活跃 thread 标题/topic 是否漂移，可提拓宽/改题（无损，自动应用）。

**Proposal schema**（分身输出，`maintenance-job-proposal-schema.ts`）：`{ placements[], newThreads[]（含临时 id → 漏斗派生正式 id）, topicProposals[]（标题/别名/摘要；漏斗按规范化标题撞注册表复用）, edges[], eventMarks[], threadRevisions[]（改题/改状态）, subjectTaggings[] }`。JSON Schema 由 zod 生成（zod v4 `z.toJSONSchema` 或 `zod-to-json-schema`，二选一后钉死；本包 zod 已是 ^4.3，优先 `z.toJSONSchema`）。

**漏斗闸序**（`exploration-thread-graph-apply-funnel.ts`，唯一写点，任一闸失败整体丢弃并回 `rejected(reason)`）：zod 形状 → 每个 turnRef 可解析（在对应会话的 turn 快照内，且不是进行中的末 turn）→ threadId/topicId 可解析（含本 proposal 新建的临时 id）→ 边只向过去（target 早于 source，跨会话按时间）→ 每 turnRef 恰一行 placement → 修订窗口外的既有 placement 不得改动 → `user_manual_edit` 来源的记录不得被作业改动 → 签名对账（`sourceTurnSequenceSignatureBySession` 与作业读到的一致，否则拒绝并标 stale）→ 派生正式 id / 复用 topic → durable-write-before-ack。骨架照抄 cline-kanban `src/state/exploratory-session-map-apply-funnel.ts` 与 `exploratory-session-map-store.ts`（串行写队列/原子写/损坏容错/路径守卫/cap-and-trim），实体换掉即可。

**成本旋钮**：`minimumTurnsBetweenMaintenanceRuns`（上下文超阈值后每 N turn 跑一次）；`useCheaperModelForkWithoutCache`（放弃 cache 换便宜模型）。

## A.6 Claude Code harness 适配器

**transcript 投影**（`claude-code-transcript-completed-turn-source.ts`）：文件 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，实时追加。按字节偏移增量读，偏移只推进到完整换行；签名 `{mtimeMs}:{size}:{offset}`；size 变小则从头重解析。记录判别（`claude-code-transcript-record-classifier.ts`）：`type:"user"` 且 content 为字符串或含 text block、非 `isSidechain`、非 `isMeta`、非 tool_result-only → 用户 turn 边界；`promptSource` / `origin` 标识 harness 注入 → `harness_injected`，不开新 turn；`type:"assistant"` 的 text block 累积为回答摘录（最后一段 ≤400）；末 turn 若无后继用户消息且宿主未报 Stop → `inProgressTurnNumber`。先用真实文件核对字段（本机 `~/.claude/projects/` 下即有），fixture 脱敏后入 `test/fixtures/`。移植 cline-kanban `src/agent-session-history/bounded-agent-transcript-reader.ts`（`readBoundedJsonLines` / `splitCompleteJsonLines`）与 `pending-user-decision-transcript-salvage.ts` 的活体 tail 思路；turn 边界分类的先例在 cline-kanban `src/conversation-tree/conversation-turn-projection.ts`（`classifyConversationTurnBoundaryMessage`）。

**fork 执行器**（`claude-code-forked-session-work-branch-executor.ts`）：spawn `claude -p --resume <nativeSessionId> --fork-session --session-id <本包生成 uuid> --output-format json --json-schema <schema JSON> --model <template.model> [--append-system-prompt <template.appendSystemPrompt>] [--settings <template.settingsPath>] <extraArgs>`，cwd = `workingDirectory`，env 加 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`（宿主 hooks 据此整体短路 + PreToolUse deny；无宿主时无害）。**绝不**给 `--bare` / `--safe-mode`（会绕过 hooks）。stdout JSON → `structured`（**实测确认**字段名就是 `structured_output`）、`usage.cache_read_input_tokens`、`session_id`。

**env 必须洗净（R1 实测新增的硬要求）**：作业往往由宿主会话内的 hook 触发，宿主 Claude Code 会往 env 里注入一批内部变量，其中 `CLAUDE_CODE_CHILD_SESSION=1` 会让分身**完全不落盘 transcript**（终端告警 `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`），`forkedNativeSessionId` 的审计价值随之归零。执行器必须删掉 `INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES` 里的全部变量：`CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_PID` / `CLAUDE_EFFORT` / `CLAUDECODE`。

**prompt cache 的实测真相（2026-09-10，Claude Code 2.1.266）**：
- `--fork-session` **拿不到**交互式主会话的对话 cache。实测本机真实 kanban 会话（opus，220k）：`cache_read = 0`、`cache_creation = 213,650`、单次 $2.20；去掉 `--json-schema` 后 $2.38，依旧 0。
- 成因是 Anthropic 已确认的 open bug [#77306](https://github.com/anthropics/claude-code/issues/77306)（2026-07-13 开，2026-08-17 官方复现并确认是 2026-06 下旬 scratchpad-directory 特性引入的 regression）：新 session id 被嵌进 system prompt 的 scratchpad 路径，前缀在 system 层就 byte 不一致。**无 workaround，无 ETA**；CHANGELOG 到 2.1.266 全文未出现 `scratchpad`。
- 轻量会话上 fork **能**命中（受控 TUI 会话 sonnet ~102k：首次 fork read 85,698/84%，再次 100%）——scratchpad 段由 statsig flag 门控，并非每个会话都注入，所以别用轻量复现去推翻重型会话的结论。
- **`--append-system-prompt` 在 `--resume` 时不参与**：实测差一个字节、乃至完全不传，命中率都不变。所以「宿主模板逐字回传」**不是** Claude Code 上的 cache 命中前提（仍照传，因为它决定分身的行为，且 dsh 侧仍需要）。
- 决策：仍按 D5 原样 fork 主会话 + 同 model，接受全价；dsh 的 fork-in-process 不受此 bug 影响（第三方实测 574,953 read / 345 create），设计方向不改。成本靠 `minimumTurnsBetweenMaintenanceRuns` 稀释。本机 Claude Code CLI 2.1.266 已确认存在 `--fork-session`（与 `--resume` 配合生成新 session id）、`--json-schema <schema>`（"JSON Schema for structured output validation"）、`--output-format`（仅 `--print`）。

**Codex**（R3 可选，`harness-codex/`）：rollout `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；`codex exec resume <sid> [PROMPT] --json -o <file>`。**先核**是否写回同一 rollout（污染主会话）；若污染则该 harness 只提供 turn 来源，执行器回落为「transcript 摘录喂全新 `claude -p`」（无 cache）。

## A.7 CLI（`/cli`，bin `agent-conversation-exploration-thread-graph`）

- `maintain --exploration-id <id> --store-root <dir> --session <json>...`（或 `--sessions-file`）`--mode incremental|initial_backfill` → 跑作业，stdout 输出 `{ok, accepted|rejected, usage}`。
- `get --exploration-id <id> --store-root <dir> [--view]` → collection 或 projection view。
- `schema` → 输出 proposal JSON Schema（调试）。
- `doctor --session <json>` → 检查 transcript 可读、`claude` 可执行、fork 参数模板完整。
- 裸用法示例（无 Kanban）：全局 `~/.claude/settings.json` Stop hook 调 `maintain`，exploration id = 根 session id。
- R0 已有 `runAgentConversationExplorationThreadGraphCli(argv) → { exitCode, output }` 的纯函数壳 + 可执行守卫；接线时保持「纯函数返回、只在入口写 stdout」的形状便于测试。

## A.8 dsh smoke 适配（`/dsh-plugin`，R4；只验证边界，不做 UI）

`export function apply(ctx: Context)`：① 注入 `ctx.subagents`、`ctx.sessions`、`ctx.sessionProjections`；② `ForkedWorkBranchExecutor` 的 dsh 实现 = `ctx.subagents.start({ provider: "fork", prompt, outputSchema, parent })` → `result.structured`；③ `CompletedTurnSequenceSource` 的 dsh 实现 = 从会话日志 `turn/start|end` + `user/message`（`source` 区分人类/注入）折出；④ 触发 = `turn/end` 会话事件（或 `agent/turn-stopping`）；⑤ 持久化：v1 仍用本包文件 store（`storeRoot` = `$DSH_HOME/…`），并注册一个 `ProjectionDefinition`（key `explorationThreadGraph`，`view` 返回 projection 整值；`apply` 只在 `turn/end` 时标 stale）。包名 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-projection` 作 peerDependencies，钉 `0.1.x-rc`（npm 已公开发布 `@deepseek-ai/dsh` 0.1.2-rc.1、`@deepseek-ai/cordis` 4.0.1；本地 clone 是 0.1.0-rc.5，预期漂移）。验证：在 dsh 源码树 `pnpm dsh web --patch <本包 cordis.yml>` 手动跑一次 + 本包内用 dsh 的测试夹具跑一个 fold 单测。参考文档：dsh `docs/architecture.md`、`docs/subsystems/subagent.md`、`docs/subsystems/session-projection.md`、`docs/subsystems/session.md`、`packages/subagent/subagent-fork-in-process/README.md`、`packages/subagent/subagent/src/types.ts`（`SubagentResult`）、`docs/cordis-tutorial/01-first-plugin.md`、`packages/hooks/README.md`。

## A.9 工具链与约定

- Node ≥22、ESM、`tsc` emit（不引 bundler）；`NodeNext` 解析——相对 import 必须带 `.js` 后缀；`verbatimModuleSyntax` 开着，类型导入写 `import type`；`noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes` 开着。
- biome 钉 2.5.12（tab/3/120）；vitest 4（`test/**/*.test.ts`，globals on）；`npm run check` = biome + typecheck + test；`prepare` = build。
- **npm 版本坑**：无 lockfile 时 `npm install` 只能用 npm ≥ 11（10.9.8 的 arborist 解析 vitest 4 peer 集时崩 `edgesOut`）；有 lockfile 后 `npm ci` 在 10.9.8 正常。改依赖用 `~/.nvm/versions/node/v24.12.0/bin/npm`。
- 命名：目录/文件/导出全部过度指定；禁 `utils`/`data`/`tmp`。
- 文档中文；`AGENTS.md` 只放承重规则 + 指针。
- 不依赖 cline-kanban 任何代码（依赖方向反了就是事故）；需要的骨架**复制**过来（A.10）。

## A.10 可从 cline-kanban 复制的骨架（只读参考路径，均在 `~/Documents/GitHub/cline-kanban`）

| 用途 | 路径 |
|---|---|
| store 骨架 | `src/state/exploratory-session-map-store.ts`（+ 测试） |
| 漏斗闸序 | `src/state/exploratory-session-map-apply-funnel.ts`（+ 测试） |
| turn 边界分类器思路 | `src/conversation-tree/conversation-turn-projection.ts`（`classifyConversationTurnBoundaryMessage`、`deriveConversationTurnProjection`） |
| JSONL 有界读取 | `src/agent-session-history/bounded-agent-transcript-reader.ts`；活体 tail：`pending-user-decision-transcript-salvage.ts` |
| lane 布局 | `web-ui/src/components/git-history/git-commit-list-panel.tsx:66-171`（`GraphRow` / `buildGraph`；`GraphSvg` 是 React 渲染，不搬） |
| 判断清单与指令风格 | `src/state/exploratory-mode-instructions.ts`、`src/prompts/exploratory-mode-append-system-prompt.ts` |

注意：cline-kanban 的 Pass B 会**删除**前两行的 session-map 文件（旧 map 链退役）。若在 main 上找不到，用 `git log --all -- src/state/exploratory-session-map-store.ts` 从历史取。

## A.11 验证

- 单测：漏斗每道闸（修订窗口、边向过去、每 turn 恰一行、manual 冲突、签名对账）；transcript 分类器（fixture：tool_result-only user 记录、isSidechain、isMeta、注入类、半行 tail、size 缩小）；proposal zod ↔ JSON Schema 往返；lane 布局（merge 线、多 parent）；projection view 跨会话时间合并。
- 集成（opt-in，需本机 `claude` 登录）：对一个真实 Claude Code session 跑 `maintain`，断言 `structured` 满足 schema 且 `usage.cacheReadInputTokens > 0`（D5 的核心前提，**R3 第一件事**）。本机 task agent 默认走 better-ccflare 代理，cache 头是否透传也要在这一步一并验证。
- CLI e2e：fixture transcript → `maintain --mode initial_backfill`（executor 用夹具回放）→ `get --view` 断言 lane 数与边。
- 完成定义：`npm run check` 全绿；README 含裸用法；tag `v0.1.0`（由用户执行或明示授权）并把 commit SHA 交回 cline-kanban 任务 b04a4。

## A.12 里程碑

R0 脚手架（**已完成**）→ R1 core（**已完成**）→ R2 claude harness（**已完成**）→ R3 作业 + CLI（**已完成**）→ R4 dsh smoke（**已完成**）；`npm run check` 绿，69 单测 + 1 opt-in 集成。原文后续：→ R2 claude harness（投影 + 执行器 + fixture）→ R3 作业 + CLI（先实测 cache 命中）→ R4 dsh smoke → tag v0.1.0。R3 内 Codex 可选。执行顺序自行拓扑排序，不要为「先做哪个」问用户。

## A.13 与 cline-kanban 的契约（两个 pass 的共享真相）

1. cline-kanban 依赖 `github:RealmX1/agent-conversation-exploration-thread-graph#<sha>`，`import` 子路径 `/core` 与 `/harness-claude-code`；web-ui 只 import `/core` 的**类型与纯函数**（projection view 类型、`layoutThreadGraphLanes`）。
2. cline-kanban 提供：`explorationId = workspaceTaskId`；`sessions[]`（主会话在前；每条含 `nativeSessionId` / `transcriptPath` / `workingDirectory` / `launchArgvTemplate{model, appendSystemPrompt, settingsPath, extraArgs}` / by-the-way 的 `forkedFromParentSessionTurnNumber`）；`storeRoot`；触发时机（Stop 边沿 + 防抖 + 每 exploration 并发 1）。
   注（R1 实测修正）：`launchArgvTemplate` 仍**原样回传**，但它在 Claude Code 上**不再是 cache 命中的前提**——`--append-system-prompt` 在 `--resume` 时根本不参与，且 fork 因 [#77306](https://github.com/anthropics/claude-code/issues/77306) 恒不命中主会话 cache（详见 A.6）。逐字回传的理由变成「决定分身行为」与「dsh 侧仍需要」，宿主侧无需为此改动。
3. 本包保证：作业 fork 进程 env 含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`，并**删掉宿主注入的 `CLAUDE_CODE_*` / `CLAUDECODE` 内部变量**（见 A.6，否则分身不落盘 transcript）；作业不写宿主任何文件，只写 `storeRoot`；所有写入经漏斗；`ForkedWorkBranchResult.usage` 回报 cache 读量。
4. 变更协议：改 schema 必 bump `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION` 并在 `CHANGELOG.md` 记；cline-kanban 升级 = 换 SHA。

## A.14 假设与风险（接手时知道即可）

- 假设：修订窗口 k=3；fork 用 `--session-id` 固定并登记，jsonl 不删；fork 与主会话同 model（吃 cache），提供「便宜模型不吃 cache」配置；不发布 npm；Codex harness 副作用核实后再定。
- 风险（R1 实测后更新）：
  - ~~cache 命中率~~ → **已定性：Claude Code 上恒不命中**（#77306，无 ETA）。代理透传与账号轮换都已排除（ccflare 单账号 session 策略、cache 头正常透传）。
  - `--json-schema` 输出字段名 → **已确认为 `structured_output`**；退路（prompt 要求纯 JSON + zod 校验）也实测可用，不传 schema 时模型照样回干净 JSON。
  - **成本：实测 $2.2–$2.4/次 @220k 上下文**（原估 $0.3 偏乐观约 8 倍），且随上下文线性增长。opt-in + `minimumTurnsBetweenMaintenanceRuns` 是唯一缓解手段，宿主侧默认值要保守。
  - dsh 漂移（peer 钉 rc，smoke 不进主路径）；transcript 格式漂移（解析失败降级为 unavailable + 置信度标注，不炸）。
