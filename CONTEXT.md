# agent-conversation-exploration-thread-graph

把「一次 agent 会话探索场次」建模为 git-graph 语义的 thread graph 的核心库：thread = 分支（lane），turn = 提交，多对一关系边 = merge。本文件只是术语表；实现与计划见 `.plan/docs/exploration-thread-graph-core-handoff.md`。

## Language

### 探索场次与会话

**Exploration（探索场次）**：
使用者一次 sit down、从一个引子开始的探索。物理上是一组 ConversationSession（主会话 + by-the-way 分叉会话 + 将来的子任务会话）；thread graph 挂在 Exploration 上，不挂在单个会话上。
_Avoid_: task、卡片、session（后者是它的组成部分）

**ConversationSession（会话）**：
某个 harness 的一次原生会话（Claude Code session / Codex rollout / dsh session），由 `harnessKind` 与 `nativeSessionId` 标识。
_Avoid_: chat、thread（thread 在本语境指探索线）

**Harness（harness）**：
承载会话的 agent 运行器（Claude Code CLI、Codex CLI、DeepSeek Harness）。每种 harness 有各自的会话日志格式与 fork 方式。
_Avoid_: agent（歧义：指模型分身还是运行器）、provider

### 轮次

**Turn（轮次）**：
由真实用户提交开启的一轮对话，等价于 git 提交；编号权威在「已完成 turn 序列」来源。引用键是 TurnRef = `{conversationSessionId, turnNumber, turnCheckpointCommit|null}`。
_Avoid_: message、round、step

**CompletedTurn（已完成轮次）**：
已有结束边界的 Turn（下一条用户消息已出现，或 harness 报告 Stop / `turn/end`）。进行中的末 turn 不是 CompletedTurn，不参与判定。
_Avoid_: closed turn、finished turn

**HumanTypedMessage / HarnessInjectedMessage（人类输入 / harness 注入消息）**：
用户消息的来源区分：前者开启新 Turn；后者（skill 内容、hook 提醒等）不开新 Turn，只保留可见。
_Avoid_: system message（那是另一层）

**TurnSubjectTags（轮次主题标签）**：
Turn 上的自由标签（规范化去重，≤8）。是原料，不进 Topic 注册表；多主题即多标签。
_Avoid_: topic（topic 是策展产物，只挂 thread）、labels

**TurnEventMark（轮次事件标注）**：
Turn 上的事件标记：`milestone | decision_point | open_question | finding_candidate`。只是事件，不承担结构。
_Avoid_: node kind、annotation

### 探索线与主题

**ExplorationThread（探索线）**：
Exploration 内一条时间性探索线，等价于 git 分支 / lane。有父 thread（根为 null）、分叉锚点 Turn、生命周期 `active | concluded | parked | abandoned`、恰一个 primaryTopicId。
_Avoid_: branch（保留给 git 本体与 work branch）、lane（只在渲染层用）、topic node

**Topic（主题）**：
workspace 级可复用的主题实体（标题 ≤80、别名 ≤8、一句摘要），只挂在 ExplorationThread 上；是 lane 的身份，也是跨 Exploration「同主题」关联键。
_Avoid_: tag、subject、category

**TopicRegistry（主题注册表）**：
storeRoot 级别的 Topic 集合，只在 fork 新 thread 时触碰。
_Avoid_: taxonomy、topic tree

**TurnThreadPlacement（轮次归属）**：
Turn → ExplorationThread 的归属记录，单独成表；v1 每 Turn 恰一行，将来多行表示一个 Turn 坐多条 lane。
_Avoid_: assignment、membership

**Deviation（偏离）**：
「读者在导航图上会希望单独一条线来看的方向变化」。由拥有完整上下文的 work-branch 分身直接判断，必附 deviationRationale；漏斗只校验形状不校验语义。
_Avoid_: digression（仅作口语解释）、topic switch

**RelationEdge（关系边）**：
Turn → 更早 Turn/thread 的有向边，可多条：`continues | forks_from | returns_to | draws_from | concludes`。`concludes` 收口某 thread，渲染为合流线（merge commit）。
_Avoid_: link、reference、parent（parentIds 是渲染层派生值）

**RevisionWindow（修订窗口）**：
维护作业可改写的最近 k=3 个已归位 Turn 的 placement；更早的冻结，只能用户手改。
_Avoid_: lookback、frontier（frontier 指最后已归位的 turn 编号）

### 维护与产出

**WorkBranchMaintenanceJob（工作分支维护作业）**：
由主会话 fork 出的一次性 headless 会话（同 model / 同 system prompt / 同消息前缀以命中 prompt cache），只输出 JSON 判定，经 ApplyFunnel 落盘。两种模式：`initial_backfill`（首次全量归位，可分批）与 `incremental`（frontier 之后的新 Turn + RevisionWindow）。
_Avoid_: subagent（dsh 术语，只在 dsh 适配层用）、classifier、summarizer

**ForkedWorkBranch（fork 出的工作分支）**：
WorkBranchMaintenanceJob 实际运行的那个分身会话（Claude Code `--fork-session` 的新 session / dsh fork-in-process 子代理）。
_Avoid_: clone、child session

**MaintenanceProposal（维护提案）**：
分身输出的结构化判定（placements / newThreads / topicProposals / edges / eventMarks / threadRevisions / subjectTaggings），是 ApplyFunnel 的输入，不是已落盘的事实。
_Avoid_: result、update、patch

**ApplyFunnel（apply 漏斗）**：
thread graph 唯一写点：按固定闸序校验 MaintenanceProposal，任一闸失败整体丢弃并回 rejected(reason)。
_Avoid_: validator、reducer、pipeline

**GenerationSource（记录来源）**：
一条记录是谁写的：`work_branch_maintenance_job` 或 `user_manual_edit`。后者优先，作业不得改动。
_Avoid_: author、origin

**CompletedTurnSequenceSource（已完成轮次序列来源）**：
某 harness 的「读出会话已完成 Turn 序列」实现，附 sourceSignature 与 projectionConfidence。
_Avoid_: transcript reader（那是 Claude Code 的一种实现）、parser

**ForkedWorkBranchExecutor（fork 执行器）**：
某 harness 的「以父会话为种子起一个分身、要求结构化输出」实现。
_Avoid_: runner、spawner

**ProjectionView（投影整值）**：
宿主渲染所需的一整份派生值（跨会话按时间合并的 Turn 行、lane、parentIds、stale 标记）。每次整值替换，不做增量补丁。
_Avoid_: view model（泛）、delta、patch

**StaleReason（过期原因）**：
collection 落后于会话的原因：`new_turns_not_yet_placed | turn_source_signature_changed | null`。
_Avoid_: dirty、outdated

### 适配与宿主

**HarnessAdapter（harness 适配器）**：
某 harness 的 CompletedTurnSequenceSource + ForkedWorkBranchExecutor 实现（`/harness-claude-code`、`/harness-codex`、dsh 插件内）。
_Avoid_: driver、backend

**HostGlue（宿主胶水）**：
把 Exploration 身份、会话清单、触发时机、渲染壳接到本包上的宿主代码（cline-kanban / dsh 插件）。本仓库不含 cline-kanban 胶水。
_Avoid_: integration、bridge

**StoreRoot（存储根目录）**：
宿主传入的本包文件 store 根目录；下有 `topic-registry.json` 与 `explorations/<explorationId>/exploration-thread-graph.json`。
_Avoid_: data dir、cache dir

### 退役术语

- **session map** → 改称 thread graph。
- **map anchor marker** → 不再有 marker；turn 编号来自 CompletedTurnSequenceSource。
- **topic tree / topic node** → topic 不是节点，thread 才是 lane。
