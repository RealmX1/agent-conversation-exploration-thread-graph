# CHANGELOG

记录 `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION`、公开 API（`/core` `/harness-claude-code` `/cli`）与宿主契约（handoff A.13）的变更。宿主升级 = 换 git 依赖的 commit SHA，所以每条都要写清「消费方需要改什么」。

## Unreleased

### R2 Claude Code harness

- `/harness-claude-code` 落地：`ClaudeCodeTranscriptCompletedTurnSource`（按字节偏移增量投影、只推进到完整换行、文件变小则整份重算、签名 `mtimeMs:size:offset`）、`claude-code-transcript-record-classifier`（边界判别取自 25 份真实 transcript 的实测分布）、`ClaudeCodeForkedSessionWorkBranchExecutor`、`bounded-json-lines-reader`。
- `treatFinalTurnAsCompleted` 选项：宿主在 Stop 边沿触发时给上，末 turn 才算已完成；否则进 `inProgressTurnNumber` 不参与判定。
- 脱敏 fixture `test/fixtures/claude-code-transcript-desensitized.jsonl` 覆盖 isMeta / tool_result-only / isSidechain / task-notification 注入 / queued / 半行 tail / 文件截断。

### R3 维护作业与 CLI

- `/core/maintenance-job`：prompt 组装（含 turn 对照表）、由 zod 单向生成的 proposal JSON Schema、作业编排 `runExplorationThreadGraphMaintenanceJob`。
- `/cli` 四个子命令全部接线：`maintain` / `get [--view]` / `schema` / `doctor`。CLI 入口函数改为 **async**（消费方若直接调用需 `await`）。
- 新增 `--final-turn-completed`、`--model`、`--batch-size`、`--timeout-ms`、`--sessions-file` 参数；`storeRoot` 默认 `~/.agent-conversation-exploration-thread-graph`。

### R4 dsh smoke

- `/dsh-plugin`：`apply(ctx)` 注册 `explorationThreadGraph` projection、`DshSubagentForkedWorkBranchExecutor`（`provider: "fork"`）、会话日志纯 fold。
- **不引入 `@deepseek-ai/*` 依赖**：只钉一份用得到的最小结构性契约（`dsh-session-seam-contracts.ts`），dsh 漂移时只有这一个文件要动。
- `user/message.source` 的注入判别是**保守前缀匹配**，认不出来按人类输入处理；dsh 词表定稿后改 `DSH_HARNESS_INJECTED_USER_MESSAGE_SOURCE_PREFIXES` 即可。

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
