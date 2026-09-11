# Pass A 完工交接 —— 写给产出 `exploration-thread-graph-core-handoff.md` 的那个 agent

> 你写的那份 handoff 我执行到 R4 收口，**除 A.8 的 dsh 实跑与 `/harness-codex` 外全部落地**（缺口见 §5、§7）。
> 本文只讲**你不知道的部分**：实测推翻了什么、我替你做了哪些决定、B.2 开工前必须先看的东西、以及我没做的部分。
> 计划本身已就地更新（A.12 里程碑表、A.13 第 1 与第 5 条、A.6 的 cache 实测段、A.11 的验证口径、
> A.8 的实际完成范围补记、A.14 的风险重估，以及一批过期的闸编号），不在本文重复。
>
> 本文已由一个独立 codex agent 逐条对着仓库复审过（55 条断言），查出的 4 处事实错误与 5 处过度断言均已改正；
> 凡涉及 cache / 成本 / GitHub issue 时间线的数字属**离线不可核验**，保留原样并在此声明其证据来自 R3 实测记录。

## 1. 交付坐标

| 项 | 值 |
| --- | --- |
| SHA（B.2 该固定的） | `4fd33ae34c9e2cc6d1b24ee4a8a12b9aa6aa2bb8` |
| tag | `v0.1.0` → 上面这个 SHA（**未 push**，`github:` 依赖走 SHA 不需要它） |
| 已 push 的 ref | `origin/task-bcb8b-exploration-thread-graph-core-pass-a` |
| 本地 base | `main` 已 ff 到同一 commit；`origin/main` 仍在 `4def9c5`（按规则不 push base） |
| 检查链 | `npm run check` 全绿：**108 通过 + 1 跳过**。跳过那条是真实 `claude` fork 的 opt-in 集成（env 开关控制），检查链默认不覆盖它 |
| 包版本 | `package.json` 的 `version` 仍是 `0.0.0`——tag 名不等于包版本。`github:` 依赖按 SHA 解析，不受影响，但别把它当版本号读 |

commit 链：`4def9c5` R0 脚手架 → `a2e1ae0` R1–R4 → `7005949` RVF 修复 14 条 → `4fd33ae` Serena 配置。

**`a2e1ae0` 是废弃快照**，别引它：它有 5 个 high 缺陷，且公开 API 与最终版**不兼容**。
同名 tag 曾指向它，现已移到 `4fd33ae`。

**注意：这两份文档本身不在 `4fd33ae` 里。** 本文未跟踪，计划与 `AGENTS.md` 的本轮修订也未提交，
且 `package.json` 的 `files` 不含 `.plan/`。B.2 只钉 SHA 拿不到它们——要么单独传阅这两份，要么等这几笔提交后换 SHA。

## 2. 三条实测结论推翻了计划的前提

### 2.1 D5 的 cache 前提在 Claude Code 上不成立（最重要）

你写的是「fork 必须与主会话同 model / 同 append-system-prompt / 同 settings，**prompt cache 命中是 D5 的前提**」。
实测（Claude Code 2.1.266，本机真实 kanban 会话，opus，约 220k 上下文）：

| 场景 | cache_read | created | 单次成本 |
| --- | --- | --- | --- |
| fork 真实交互式主会话 | **0** | 213,650 | **$2.20** |
| 同上，去掉 `--json-schema` | **0** | 234,206 | **$2.38** |
| 受控轻量 TUI 会话（sonnet ~102k）首次 fork | 85,698（84%） | 16,227 | $0.083 |
| `-p` 父会话 fork（父再长一 turn 后仍命中） | 100% | ~260 | $0.013 |

成因是 **Anthropic 已确认的 open bug [#77306](https://github.com/anthropics/claude-code/issues/77306)**：
`--fork-session` 铸造新 session id，而 session id 被嵌在 system prompt 的 scratchpad 路径里，
前缀在 system 层就 byte 不一致。2026-07-13 首报，2026-08-17 官方复现并承认是 2026-06 下旬
scratchpad-directory 特性引入的 regression，**至今无 workaround、无 ETA、无 assignee、无关联 PR**；
CHANGELOG 全文（到 2.1.266）`scratchpad` 出现 0 次。轻量会话能命中是因为那段 scratchpad 由 statsig flag
门控、并非每个会话都注入——**别用轻量复现去推翻重型会话的结论**。

**对你的规划的影响**：A.14 原估「$0.3/turn」偏乐观约 8 倍。用户已拍板**维持 D5 原样**（fork 主会话 + 同 model），
接受全价，理由是契约与文档零改动、bug 修好后自动变便宜、dsh 的 fork-in-process 本就不受影响
（第三方实测 574,953 read / 345 create）。

**但这直接决定了 B.2 的触发策略**：在维持「同 model fork 主会话」这个前提下，
`minimumTurnsBetweenMaintenanceRuns` 不再是「可选的成本旋钮」，而是**宿主侧唯一的成本控制手段**
（本包侧另有 `overrideModel` 可降档，但那改变判定质量，属于换方案而非调参），宿主侧默认值必须保守。
按实测单价直乘：40 次调用若都在 ~220k 上下文上就是 $88–$95——单价随上下文增长，短会话便宜得多，
别把这个数当成任意场次的预算。
建议 B.2 把它做成显式 opt-in + 明显的默认节流，而不是默认全开。

### 2.2 `--append-system-prompt` 不参与 `--resume` 的 cache 前缀

实测只覆盖 cache 命中率这一个维度：差一个字节、乃至**完全不传**，命中率都不变。所以 A.13-2 里
「模板逐字回传是 cache 命中的前提」这条**在 Claude Code 上不成立**。**但这不等于该参数在别处也无效**——
它仍决定分身行为，且 dsh 侧需要，所以照传；只是宿主侧不必再为「保证逐字一致」加任何机制。

### 2.3 新发现的硬约束：fork 必须洗掉宿主注入的 env

你的 handoff 只写了「env 必含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`」。实测漏了反向的一半：
继承宿主 Claude Code 的 `CLAUDE_CODE_CHILD_SESSION=1` 会让分身**完全不落盘 transcript**
（终端告警 `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`），
`forkedNativeSessionId` 的审计价值随之归零。作业由宿主会话内的 hook 触发时这些变量**就在 env 里**
（从 CLI 手工调则不一定），而 hook 触发正是主路径——所以洗掉是必需而非防御性编程。
已落为 `INHERITED_HOST_CLAUDE_CODE_ENV_VARIABLE_NAMES` 常量（8 个明确名称，不是通配 `CLAUDE_CODE_*`）
+ 单测钉住，并写进 A.6 与 A.13-3。

## 3. B.2 开工前必读：RVF 之后的公开 API 增量

完整清单在 A.13 第 5 条。只强调对 B.2 影响最大的三点：

1. **`applyExplorationThreadGraphMaintenanceProposal` 新增必填 `turnsUnderJudgement`（破坏性）**。
   但**只影响直接调漏斗的宿主**。cline-kanban 应该走 `runExplorationThreadGraphMaintenanceJob`，
   由它内部处理待判范围选择、prompt 组装、fork、漏斗落盘——除此之外没有理由直接碰漏斗。
2. **`ExplorationThreadGraphApplyRejectionReason` 加了取值**。web-ui 或 server 若对它做穷举 `switch`，
   TypeScript 会在你换 SHA 后报缺分支——那是好事，照着补即可。
3. **Stop 边沿触发必须显式给 `treatFinalTurnAsCompleted: true`**（CLI 是 `--final-turn-completed`）。
   默认 `false` 会把末 turn 当成「进行中」排除掉——而 Stop 触发时刚结束的恰恰就是那个 turn。
   不给这个开关等于每次都少判一个 turn，且漏斗会拒绝任何指向它的 turnRef。它不是新增 API，
   但是 B.2 最容易静默踩空的一处。

另外 store 现在有**跨进程锁文件** `<storeRoot>/exploration-thread-graph-store-write.lock`
（不是 `.lock`）。宿主的备份 / 体检 / 清理逻辑要放过它，且**不得删除活动锁**；
路径一律用导出的 `resolveExplorationThreadGraphStoreWriteLockPath(storeRoot)` 取，别自己拼字符串。

## 4. 我替你做的决定（你可以反悔，成本都很低）

| 决定 | 理由 | 怎么反悔 |
| --- | --- | --- |
| `layoutThreadGraphLanes` **不导出 `convergingLanes`** | 移植源每行末尾会对泳道去重，导致该字段**恒为空**；导出一个永远空的公开字段比不导出更坏 | 去掉去重步骤才能让它有意义，那会改变泳道几何 |
| projection view 补两条**隐式** parent（同 thread 上一 turn、thread 首 turn 接分叉锚点） | 只认显式 `continues` 边的话，分身漏发一条边整张图就碎成孤立点 | 改 `exploration-thread-graph-projection-view.ts`，但先想清楚碎图怎么办 |
| `applyExplorationThreadGraphMaintenanceProposal` 入参加 `currentTopicRegistry` 与 `proposalSourceTurnSequenceSignatureBySession`（你的伪签名里没有） | 前者是「派生正式 id / 复用 topic」这道闸的必要输入；后者是闸 2 对账的对象，纯函数拿不到就没法对账 | 无——这是实现必需 |
| `concludes` 边允许 target thread 的最后一个 turn **等于** source turn | 收口边常常就落在该 thread 最后一个 turn 上；严格「只向过去」会让这种自然输出整份被拒，在生产里会反复触发 | 视图层已滤掉自指 parent，收紧闸即可 |
| 提交了 `.serena/.gitignore` 与 `.serena/project.yml` | base-branch-sync 的 WIP 保护闸要求 worktree 能 clean，而未跟踪的 `.serena/` 触发了自指陷阱（stash 收走 `.serena/.gitignore` → `project.local.yml` 变成未忽略 → 永远 dirty）。内容与机器无关，且 cline-kanban 仓库已提交同一份 | revert `4fd33ae`，但 handback 会再次卡住 |
| tag `v0.1.0` 从 `a2e1ae0` 移到 `4fd33ae` | tag 未 push、未被消费；留在一份有 5 个 high 缺陷且 API 不兼容的快照上会误导唯一的消费者 | `git tag -f v0.1.0 a2e1ae0` |

## 5. 我没做的部分

- **`/harness-codex` 只有一个判别常量**。你把它标为「R3 可选」，我按可选处理了。开工前先核实
  `codex exec resume` 是否写回同一 rollout（污染主会话）——A.6 里你自己也点了这一条。
- **dsh 插件只到 smoke，且比字面更窄**：`apply(ctx)` **只**注册一件事——以会话日志纯 fold 作 `apply` 的
  turn 快照 projection（`ctx.sessionProjections` 缺席就整个跳过）。`DshSubagentForkedWorkBranchExecutor`
  是**单独导出的类**，`apply` 既不构造也不注册它；A.8 的 ④（`turn/end` 触发）与 ⑤ 的图 projection /
  stale 标记 / store 写入**都没接**。12 个单测覆盖 fold 与执行器，
  但**没有在 dsh 源码树里实跑过**（`pnpm dsh web --patch` 那步没做），也**没有引入 `@deepseek-ai/*` peerDependency**——
  我只钉了一份用得到的最小结构性契约（`src/dsh-plugin/dsh-session-seam-contracts.ts`）。
  理由：dsh 是 developer preview 且明示破坏性变更，把类型 import 进来会让 `/core` 的检查链随 dsh 漂移一起红。
  **一个已知的不确定点**：`user/message.source` 的取值枚举在公开文档和本地 clone 里都查不到，
  我用了保守前缀匹配（认不出来按人类输入处理）。注意它**不影响 turn 数**——turn 由 `turn/start` /
  `turn/end` 建立，`user/message` 只改摘录与 `userMessageOrigin`；判错的后果是分身把一条注入上下文
  当成人类提问来读。
  dsh 词表定稿后改 `DSH_HARNESS_INJECTED_USER_MESSAGE_SOURCE_PREFIXES` 一个常量即可。
- **dsh 的 projection 只回 turn 快照整值**，图本身仍落在本包文件 store（A.8 的 ⑤ 就是这么设计的），
  没做 dsh 原生持久化。
- **本包侧的成本旋钮只有 `overrideModel`（CLI `--model`）**；`minimumTurnsBetweenMaintenanceRuns` 是**宿主侧**的触发节流，
  本包没有替宿主实现它（它属于「什么时候触发」，是 B.2 的胶水职责）。

## 7. B.2 会踩但计划里没写的几处（codex 复审补出，逐条已在代码里核过）

- **落盘布局**：`<storeRoot>/topic-registry.json` 是**整个 storeRoot 共享**的（不按 exploration 分），
  图本体在 `<storeRoot>/explorations/<explorationId>/exploration-thread-graph.json`，锁文件见 §3。
  两份 JSON 是**各自原子写**，不是跨文件事务——宿主别假设它们同一时刻一致。
  文件缺失或 JSON 损坏会退化成空集合；但权限之类的读取错误仍然抛。
- **`placedTurnCount` 不是「本次新增数」**，而是落盘后 collection 里 placement 的**总数**
  （`exploration-thread-graph-maintenance-job.ts:235`）。要算增量得自己前后相减。
- **一次作业最多判 `batchSize`（默认 40）个 turn**，剩下的经 `remainingTurnCount` 回报，
  由调用方自己安排续跑。`incremental` 模式即使没有新 turn，也可能因修订窗口重判——不是空跑就一定零成本。
- **入口只有五个子路径**（`./core` `./harness-claude-code` `./harness-codex` `./cli` `./dsh-plugin`），
  **没有根入口**；ESM only，`engines.node >= 22`；`files` 只含 `dist` / `README.md` / `CONTEXT.md`。
- **`/core` 不保证能进浏览器包**：它静态导出依赖 node `fs` 的 store。web-ui 要用图，
  建议在 server 侧把 projection（含 lane 布局）算好再送前端，别把 `/core` 直接打进浏览器 bundle。
- **渲染必须同时给源快照**：只有 collection 摊不出 turn 行——`buildExplorationThreadGraphProjectionView`
  要 turn 快照才能出行；CLI `get --view` 在没给有效 sessions 时会「成功返回空行」，别把它当成图是空的。
  行序是**新→旧**，`threadId` 与 topic 都允许为 null。
- **hooks 隔离与并发是宿主的活**：本包只保证 fork 进程 env 带
  `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`；据此短路事件、PreToolUse deny 要 B.2 自己实现。
  store 的写锁只覆盖**落盘那一段**，不覆盖前面那次昂贵的 fork——所以它**不能**替代「每 exploration 并发 1」。

## 6. 还悬着的风险

- **cache bug 无 ETA**。若 Anthropic 修了，成本自动回落，无需改任何代码——但**别按「即将修复」规划**：
  官方承认距今已 24 天、发了 9+ 个版本，无一条 changelog 触及该根因；第三方在 2.1.260（比确认晚 20 天）
  实测机制原封不动。我在 2.1.266 上的实测目前是这条 bug 最新的公开数据点。
- **transcript 格式漂移**。判别器的判据取自本机 25 份真实 transcript 的实测分布
  （`promptSource` × `origin.kind` 交叉表），不是猜的；但 Claude Code 改格式时它会静默漏掉人类边界、
  把相邻两个 turn 合并——**后续编号会整体前移，也就是会错位**（编号取 `accumulatedTurns.length + 1`）。
  编号是整个包的地基，所以这条要按「会错」防，不能按「保守地少判」自我安慰：
  签名对账闸能挡住并发写入不一致，挡不住判定范围本身选错。
- **`4fd33ae` 这笔 Serena hygiene commit 没有被 RVF 审过**，我也**没有**把 round-baseline 封到它上面。
  下一次 Stop hook 可能把它当作「未审已提交改动」问一次；那是诚实的行为，届时 decline 即可。
