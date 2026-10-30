# agent-conversation-exploration-thread-graph

把「一次 agent 会话探索场次」建模为 **git-graph 语义的 thread graph**：thread = 分支（lane），turn = 提交，多对一关系边 = merge。由**主会话 fork 出的 work-branch 作业**在每个 turn 结束后判定归属并维护，产出给任何宿主渲染的 projection 整值。

- 零宿主依赖的核心库 + 各 harness 适配器 + CLI；UI 渲染壳由宿主自己做。
- 第一宿主：[cline-kanban](https://github.com/RealmX1/cline-kanban)（经 `github:` git 依赖引用本包）。
- 目标宿主：DeepSeek Harness（dsh）插件（`/dsh-plugin` 入口）。
- 术语表见 `CONTEXT.md`；完整计划、接口与契约见 `.plan/docs/exploration-thread-graph-core-handoff.md`。

## 状态

R0–R4 全部落地，`npm run check` 全绿（108 个单测 + 1 个 opt-in 集成测试）：核心 schema / store / apply 漏斗 / projection view / lane 布局、Claude Code harness（transcript 增量投影 + fork 执行器）、维护作业与 CLI、dsh 插件 smoke。

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

## 裸用法（无 Kanban）

在 `~/.claude/settings.json` 里给 Stop hook 挂一条命令。`--final-turn-completed` 是关键：
Stop 边沿意味着末 turn 已经结束，不给这个开关的话末 turn 会被当成「进行中」而不参与判定。

`--session` 的 JSON 里，`transcriptPath` / `workingDirectory` **必须是绝对路径**：单引号内 shell 不展开 `~`，
Node 的 `fs` 也不做 tilde 展开，所以写成 `~/.claude/projects/...` 会让 transcript 被判为 `unavailable`——
不会报错，只会静默产出空图。下面用**不加引号**的 heredoc 先把 `$HOME` 展开成绝对路径再喂给 `--session`。

```bash
SESSION_JSON=$(cat <<JSON
{"harnessKind":"claude_code","nativeSessionId":"<session id>","transcriptPath":"$HOME/.claude/projects/<encoded-cwd>/<session id>.jsonl","workingDirectory":"<repo 绝对路径>","launchArgvTemplate":{"model":"default","appendSystemPrompt":null,"settingsPath":null,"extraArgs":[]}}
JSON
)

agent-conversation-exploration-thread-graph maintain \
	--exploration-id <根会话 session id> \
	--store-root "$HOME/.agent-conversation-exploration-thread-graph" \
	--session "$SESSION_JSON" \
	--mode incremental --final-turn-completed
```

配好后先跑一次 `doctor` 确认 `transcriptIsReadable` 为 `true`，再挂上 Stop hook——
这是唯一能把「路径写错」和「本来就没有新 turn」区分开的地方。

读回来（沿用上面的 `$SESSION_JSON`）：

```bash
# 落盘的 collection
agent-conversation-exploration-thread-graph get --exploration-id <id> --store-root "$HOME/.agent-conversation-exploration-thread-graph"
# 给宿主渲染的 projection 整值（需要 --session 才能摊出 turn 行）
agent-conversation-exploration-thread-graph get --exploration-id <id> --store-root "$HOME/.agent-conversation-exploration-thread-graph" --view --session "$SESSION_JSON"
# 分身要满足的 JSON Schema（调试用）
agent-conversation-exploration-thread-graph schema
# 体检：transcript 可读、`claude` 可执行、fork 参数模板完整、没有会绕过 hooks 的参数
agent-conversation-exploration-thread-graph doctor --session "$SESSION_JSON"
```

多个进程（多个 Stop hook 触发的 CLI、或宿主进程与 CLI 并存）可以安全地共用同一个 `storeRoot`：
写路径除了进程内串行队列，还会在 `<storeRoot>/exploration-thread-graph-store-write.lock` 上取一把跨进程锁
（超 15s 的锁按持有者已死回收；等锁超 20s 报错而不是硬写）。读路径不取锁，永不抛。

首次接入一个已经聊了很久的会话时先跑一次 `--mode initial_backfill`（可用 `--batch-size` 分批），
之后每个 turn 用 `--mode incremental`。`storeRoot` 省略时默认 `~/.agent-conversation-exploration-thread-graph`。

### 成本提醒

维护作业每次都会 fork 主会话，而 Claude Code 的 `--fork-session` 目前**拿不到主会话的 prompt cache**
（Anthropic 已确认的 open bug [#77306](https://github.com/anthropics/claude-code/issues/77306)，2.1.266 上仍复现）。
2026-09-10 实测：220k 上下文的 opus 会话，单次作业约 $2.2–2.4，且随上下文线性增长。
所以**不要每个 turn 都跑**——用触发稀释（每 N 个 turn 一次），或用 `--model` 降档。
该 bug 修好后成本会自动回落；dsh 的 fork-in-process 不受影响。

## 与宿主的契约

与 cline-kanban 的共享真相是 handoff 的 A.13：宿主提供 `explorationId`、`sessions[]`（含 `launchArgvTemplate`）、`storeRoot` 与触发时机；本包保证 fork 进程 env 含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`、只写 `storeRoot`、所有写入经漏斗、回报 prompt cache 读量。改 schema 必 bump `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION` 并记 `CHANGELOG.md`；宿主升级 = 换 commit SHA。

### 分身执行、取消与进度

分身请求、维护入口和 CLI 均没有 Agent 总运行时限，不再接受 `timeoutMs` 或 `--timeout-ms`。健康进程可以持续输出或保持静默，直到原生正常结束。通过 `signal: AbortSignal` 显式取消；CLI 的 `SIGINT` / `SIGTERM`（含重复信号）会转为同一取消信号，并持续等待清理结束。fork 已返回时，维护作业在获取写锁及重读 turn 后仍检查取消，取消的提案不再落盘。

Claude 执行器观察进程启动身份与已识别后代，使用 `onProcessObservation` 回报进程归属、最近观察和输出活动，供宿主持久保存。取消后先发 `SIGTERM`，两秒后必要时升级 `SIGKILL`；根进程先退出不缩短后代的优雅清理窗口。五秒清理窗口内持续补查 token 可证的后代，不依赖输出管道关闭。返回的 `cancellationConfirmation` 区分本地停止确认和未知，不把信号发送冒充远端服务已取消。PID 启动身份变化时不发送信号，PGID 改变不代表原进程退出；查询缺证时保留未知。

dsh 只在调用方明确取消后向 provider 发 `AbortSignal`。provider 返回结束回执才确认停止；取消后五秒仍未返回则报告确认未知。该窗口只约束取消确认等待，不限制 Agent 自身运行时间。单次 `ps` 查询等操作仍有独立超时。

宿主可在 `executionOwnershipToken` 中传入已持久登记的随机执行归属，并通过可等待的 `beforeProcessSpawn` 屏障先保存 dispatch intent；进程入口在屏障结束后再次核验取消。`onProcessObservation` 回报同一个 token。恢复查询只将 NUL 边界原生环境中的独立 token 键用作正向归属：Darwin 使用 `KERN_PROCARGS2`，Linux 使用 `/proc/<pid>/environ`；argv 或其他环境值里的 token 文本不算归属。token 缺席、查询失败、清空环境或父链缺失的孤儿不能证明退出。进程时间查询和解析均固定 UTC，避免夏令时回拨漏掉新后代。取消后的最终补查仍有未知孤儿时，或五秒清理窗口内未取得完整证据时，确认保持 `unknown`。原生开机 UUID 变化可以证明旧代进程已全部退出，不通过墙钟推算代际。

派发屏障未结束时也可取消，立即返回 `cancelled/not_started`，屏障后来完成不再启动进程。启动身份是不透明的 PID + 原生启动时间，不包含可变 PGID。取消与恢复仍接受旧版 PID + PGID + 启动时间记录，按 PID 与出生信息核对；同一进程改变 PGID 或缺少 token 不影响已确认记录扩展后代，出生信息变化则不发信号，无法识别的格式保留 `unknown`。消费方无需转换或丢弃旧记录。空登记表不能仅凭根 PID 建立归属，`extendOwnedProcessStartIdentities` 只扩展已确认身份。未能证明归属的新生进程，即使被存活的 subreaper 收养，也保留 `unknown`，不对它发送取消信号。

Darwin 的新生孤儿补证还读取内核的原始父进程代际，排除可证明由 launchd 直接启动的系统服务；不按名字猜测进程归属。该只读辅助程序从模块内保存的 C 源码生成可再生的本机缓存，不改宿主配置；编译或内核查询不可用时保留未知，编译器或存储证据变化后自动重验。缓存不属于跨任务交接产物。
