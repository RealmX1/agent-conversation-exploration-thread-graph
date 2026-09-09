# CHANGELOG

记录 `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION`、公开 API（`/core` `/harness-claude-code` `/cli`）与宿主契约（handoff A.13）的变更。宿主升级 = 换 git 依赖的 commit SHA，所以每条都要写清「消费方需要改什么」。

## Unreleased

### 漏斗闸序修正

- 闸 3 增补「提案内临时 id 互不重复」检查：`newThreads` / `topicProposals` 自身出现重复 `temporaryThreadId` / `temporaryTopicId` 时整份拒绝。此前重复项会被临时 id → 正式 id 映射后写覆盖，两条 thread 拿到同一个正式 `threadId` 落盘。
- **公开 API 增量**：`ExplorationThreadGraphApplyRejectionReason` 新增 `duplicate_temporary_id_within_proposal`；消费方若对拒绝原因做穷举分支需补上该分支。

### 并发/时序修正

- **闸 8 签名对账不再同源自比**：`runExplorationThreadGraphMaintenanceJob` 在 fork 返回后、经漏斗落盘前，于 store 的写锁内**重读一次** `turnSource`，用「落盘时刻的新快照 + 作业发起时留存的旧签名」对账。此前两者来自同一次读取，作业执行期间新增的 turn 不会触发拒绝。
- `ExplorationThreadGraphStoreMutator` 的返回类型放宽为可返回 `Promise`（`mutateExplorationThreadGraph` 内部改为 `await mutator(...)`）——只有异步 mutator 才能把「重读 → 对账 → 落装」关进同一把 storeRoot 队列锁内。**类型是放宽而非收窄，既有同步 mutator 无需改动。**

- 闸 5 从「提案内不得重复」升级为「**恰好覆盖本次待判范围**」：分身漏判待判 turn、或给出待判范围之外的 placement，都整份拒绝。此前空 placements 的提案也会被 accepted，调用方拿到 `remainingTurnCount = 0`，而落盘的 frontier 只看最大 turn 号，中间漏掉的 turn 连 stale 都标不出来。
- **公开 API 变更（消费方必须改）**：`applyExplorationThreadGraphMaintenanceProposal` 入参新增**必填** `turnsUnderJudgement: readonly { conversationSessionId, turnNumber }[]`，取值与 prompt 里列出的待判范围一致；直接调漏斗的宿主要补这个字段（走 `runExplorationThreadGraphMaintenanceJob` 的不受影响，编排侧已接线）。
- **公开 API 增量**：`ExplorationThreadGraphApplyRejectionReason` 新增 `placement_missing_for_turn_under_judgement` 与 `placement_outside_turns_under_judgement`。

### 并发修正

- **store 的写路径补上跨进程锁**：`mutateExplorationThreadGraph` 在进程内写队列之外，还会在 `<storeRoot>/exploration-thread-graph-store-write.lock` 上取一把 `O_CREAT|O_EXCL` 锁（超 15s 判陈旧并回收，等锁超 20s 抛错）。此前 `writeQueueByResolvedStoreRoot` 只是进程内 Map，而裸用法每次 Stop hook 都是**新的 CLI 进程**：两个进程各读旧值再各自原子写，后写的会把先写的整份覆盖掉，两边还都回报成功。
- 新增导出 `resolveExplorationThreadGraphStoreWriteLockPath(storeRoot)`：宿主备份 / 体检 / 清理 `storeRoot` 时要认得这个文件，别把它当图数据复制走。
- 读路径不取锁，仍然永不抛。

### R2 Claude Code harness

- `/harness-claude-code` 落地：`ClaudeCodeTranscriptCompletedTurnSource`（按字节偏移增量投影、只推进到完整换行、文件变小则整份重算、签名 `mtimeMs:size:offset`）、`claude-code-transcript-record-classifier`（边界判别取自 25 份真实 transcript 的实测分布）、`ClaudeCodeForkedSessionWorkBranchExecutor`、`bounded-json-lines-reader`。
- `treatFinalTurnAsCompleted` 选项：宿主在 Stop 边沿触发时给上，末 turn 才算已完成；否则进 `inProgressTurnNumber` 不参与判定。
- 脱敏 fixture `test/fixtures/claude-code-transcript-desensitized.jsonl` 覆盖 isMeta / tool_result-only / isSidechain / task-notification 注入 / queued / 半行 tail / 文件截断。
- **公开类型形状变更**：`BoundedJsonLinesReadResult` 增加 `appendedBytesRemainBeyondIncrementalReadBudget`。`readAppendedCompleteJsonLines` 超预算时不再跳到文件尾读尾部，改为从当前 offset 向后截短读取窗口并置该标志；直接消费这个原语的消费方**必须循环读到该标志为 false** 才算追平。`ClaudeCodeTranscriptCompletedTurnSource` 已按此分块追平；单行长过预算导致 offset 推不动时降级为 `sourceSignature: "unavailable"` 的空快照。（修的是 >32MB 长会话 `initial_backfill` 会从文件中段把 turn 从 1 重新编号、所有 turnRef 永久错位。）

### R3 维护作业与 CLI

- `/core/maintenance-job`：prompt 组装（含 turn 对照表）、由 zod 单向生成的 proposal JSON Schema、作业编排 `runExplorationThreadGraphMaintenanceJob`。
- `/cli` 四个子命令全部接线：`maintain` / `get [--view]` / `schema` / `doctor`。CLI 入口函数改为 **async**（消费方若直接调用需 `await`）。
- 新增 `--final-turn-completed`、`--model`、`--batch-size`、`--timeout-ms`、`--sessions-file` 参数；`storeRoot` 默认 `~/.agent-conversation-exploration-thread-graph`。
- `doctor` 补齐 handoff A.7 的第二项：按 PATH 解析 `claude` 是否可执行（只解析路径、不起进程），解析不到时该会话判为不通过。输出的每个 claude_code 检查项新增 `claudeExecutableName` / `claudeExecutableIsResolvable` / `claudeExecutableResolvedPath`；**消费方注意**：机器上没有 `claude` 时 `doctor` 现在会返回 exit 1 而不再报通过。
- `/harness-claude-code` 新增导出 `DEFAULT_CLAUDE_EXECUTABLE_PATH`（执行器的 spawn 目标与 `doctor` 的探测目标共用同一个真相）。

### R4 dsh smoke

- `/dsh-plugin`：`apply(ctx)` 注册 `explorationThreadGraph` projection、`DshSubagentForkedWorkBranchExecutor`（`provider: "fork"`）、会话日志纯 fold。
- **不引入 `@deepseek-ai/*` 依赖**：只钉一份用得到的最小结构性契约（`dsh-session-seam-contracts.ts`），dsh 漂移时只有这一个文件要动。
- `user/message.source` 的注入判别是**保守前缀匹配**（`startsWith`，不是子串包含：子串会把 `noninject` 这类人类来源判成注入），认不出来按人类输入处理；dsh 词表定稿后改 `DSH_HARNESS_INJECTED_USER_MESSAGE_SOURCE_PREFIXES` 即可。

### R1 core

- `/core` 落地领域实现，公开 API 见 `src/core/index.ts`：
  - `exploration-thread-graph-schema.ts`：A.4 全部实体的 zod schema、尺寸上限常量、`formatExplorationTurnRefKey`、`normalizeTopicTitleForRegistryLookup`。
  - `exploration-thread-graph-store.ts`：文件 store（串行写队列 / 原子写 + fsync / 损坏容错 / 路径遍历守卫 / topic 上限裁剪）。`mutateExplorationThreadGraph` 把 collection 与 topic 注册表放在**同一把 storeRoot 锁**内落盘。
  - `exploration-thread-graph-apply-funnel.ts`：**唯一写点**，10 道闸（形状 / 签名对账 / turnRef 可解析 / 进行中末 turn 拒绝 / id 可解析 / 边只向过去 / 每 turn 恰一行 / 修订窗口冻结 / user_manual_edit 保护 / 派生 id 与 topic 复用）。
  - `exploration-thread-graph-projection-view.ts`、`thread-graph-lane-layout.ts`：projection 整值与纯 lane 布局。
  - `completed-turn-sequence-source.ts`、`forked-work-branch-executor.ts`：两个 harness seam 接口。
- **契约细化**（消费方需要知道，但都在 R0 之后、宿主接入之前，故不 bump schema 版本）：
  - `applyExplorationThreadGraphMaintenanceProposal` 入参增加 `currentTopicRegistry` 与 `proposalSourceTurnSequenceSignatureBySession`，返回值带 `topicRegistry`；拒绝分支带 `collectionStaleMarkUpdate`。
  - `buildExplorationThreadGraphProjectionView` 第三个入参为 `topicRegistry`。
  - `layoutThreadGraphLanes` 的 `rows` 必须**新→旧**（git log 序）；不导出 `convergingLanes`（移植源里该字段恒为空）。
  - `explorationThread` 增加 `threadTitle`；边与事件标注增加 `generationSource` / `createdAt`。
- **新增契约保证**：fork 执行器必须从子进程 env 删除 `INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES`（`CLAUDE_CODE_CHILD_SESSION` 等）。实测继承 `CLAUDE_CODE_CHILD_SESSION=1` 会让分身完全不落盘 transcript。
- **实测修正**：Claude Code 的 `--fork-session` 因上游 open bug [#77306](https://github.com/anthropics/claude-code/issues/77306) 拿不到主会话 prompt cache；`--append-system-prompt` 在 `--resume` 时不参与。宿主提供的 `launchArgvTemplate` 仍原样回传，但它不再是命中前提。详见 handoff A.6 / A.13-2 / A.14。

### R0

- R0 脚手架：单包多入口（`./core` `./harness-claude-code` `./harness-codex` `./cli` `./dsh-plugin`）、`prepare` 构建、biome 2.5.12 / vitest 4 / tsc NodeNext 检查链、入口点 smoke 测试。
- 契约常量：`EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION = 1`；作业 env 变量名 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB`。
