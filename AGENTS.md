# AGENTS.md

本文件是仓库的 agent 上下文 canonical kernel（Claude Code 经根 `CLAUDE.md` 的 `@AGENTS.md` 导入获得本文；不要复制到第二份文件）。**仓库文档以中文为主要语言**（技术标识符、路径、命令保持英文原文）。只放每会话都需要的承重规则 + 指针，每条 1-3 行；全文进 `.plan/docs/` 或 `docs/`。

## 这个仓库是什么

把「一次 agent 会话探索场次」建模为 git-graph 语义的 **thread graph**（thread = 分支/lane，turn = 提交，多对一关系边 = merge），由**主会话 fork 出的 work-branch 作业**在每个 turn 结束后判定归属并维护，产出给任何宿主渲染的 projection 整值。**零宿主依赖**：第一宿主 cline-kanban 经 `github:` git 依赖引用本包；目标宿主 DeepSeek Harness（dsh）插件。术语表 `CONTEXT.md`；完整计划与接口 `.plan/docs/exploration-thread-graph-core-handoff.md`（接手先读它）。

## 仓库形态与命令

单包多入口（ESM、`tsc` emit 到 `dist/`、不提交 dist）。子路径 exports：`./core` `./harness-claude-code` `./harness-codex` `./cli` `./dsh-plugin`；bin `agent-conversation-exploration-thread-graph`。

```bash
npm ci                 # 装依赖并经 prepare 构建 dist/（npm 10.9.8 与 11 均验证过）
npm run check          # biome + typecheck + vitest（完成定义 = 全绿）
npm run build          # tsc -p tsconfig.build.json
npm test               # vitest run（test/**/*.test.ts）
```

- **无 lockfile 时 `npm install` 只能用 npm ≥ 11**：npm 10.9.8 的 arborist 在解析 vitest 4 peer 集时崩 `Cannot read properties of null (reading 'edgesOut')`；有 `package-lock.json` 后 `npm ci` 在 10.9.8 正常。本机 nvm 有 `~/.nvm/versions/node/v24.12.0/bin/npm`（11.x）。
- biome **钉死 `2.5.12`**（`biome.json` 的 `$schema` 与 CLI 版本必须一致，升级时 `npx biome migrate --write` 一并改）。格式：tab 缩进、indentWidth 3、lineWidth 120。
- tsconfig 走 `NodeNext`：源码内相对 import **必须带 `.js` 后缀**（`./foo.js` 指向 `foo.ts`）；`verbatimModuleSyntax` 开着，类型导入写 `import type`。

## 铁律

- **唯一写点是 apply 漏斗**（`src/core/exploration-thread-graph-apply-funnel.ts`）：任何 thread / placement / edge / topic 的写入都经它，任一闸失败整体丢弃；不得另开写路径（CLI、dsh 插件、宿主都只能调它）。
- **turn 编号权威在 CompletedTurnSequenceSource**（transcript 投影 / dsh 日志）；本包不自己数 turn，也不在文件里种 marker。
- **进行中的末 turn 不参与判定**：`inProgressTurnNumber` 不进 `turns[]`，漏斗对指向它的 turnRef 一律拒绝。
- **`user_manual_edit` 优先**：该来源的记录作业不得改动；修订窗口（k=3）之外的既有 placement 作业也不得改动。
- **契约变更先改文档再改代码**：`/core` 与 `/harness-claude-code` 的公开 API、schema、env 变量名是与 cline-kanban 的共享真相（handoff A.13）。改 schema 必 bump `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION` 并记 `CHANGELOG.md`。
- **依赖方向单向**：本仓库**不得 import cline-kanban 任何代码**；需要的骨架从它**复制**过来（handoff A.10 列了路径）。dsh 包只作 `/dsh-plugin` 的 peerDependency，不进 `/core`。
- **fork 执行器的 argv 由本包完全控制**：env 必含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`；**绝不**给 `--bare` / `--safe-mode`（会绕过宿主 hooks，让分身事件被当成主任务事件）。作业只写 `storeRoot`，不写宿主任何文件。
- **prompt cache 命中是 D5 的前提**：fork 必须与主会话同 model / 同 append-system-prompt / 同 settings（模板由宿主逐字提供）；R3 第一件事是实测 `usage.cacheReadInputTokens > 0`。

## 约定

- TypeScript：无 `any`；外部 API 类型查 node_modules 而非猜；NEVER inline import（无 `await import()`、无类型位 `import("pkg").Type`）；不为过时依赖降级代码。
- 命名一律过度指定 / 自解释：目录、文件、导出、字段、事件类型都要不依赖上下文就能读出「是什么 + 处于什么状态/起什么作用」；禁 `utils` / `data` / `tmp` / `misc`。
- 文档、注释、commit message 中文；未经用户要求不 commit，绝不 push。
- 测试放 `test/`（与 `src/` 平行），脱敏 fixture 放 `test/fixtures/`；真实 `claude` 调用的集成测试必须 opt-in（env 开关），默认不跑。

## 参考文档

| 文档 | 内容 |
| --- | --- |
| `.plan/docs/exploration-thread-graph-core-handoff.md` | 完整 handoff：使命/非目标、包布局、核心接口、schema、作业与漏斗、harness 适配、CLI、dsh smoke、验证、里程碑、与 cline-kanban 的契约 |
| `CONTEXT.md` | 术语表（只放术语不放实现） |
| `README.md` | 定位、三层架构图、裸用法、与 cline-kanban / dsh 的关系 |
| `CHANGELOG.md` | schema 版本与公开 API 变更记录 |
| `~/Documents/GitHub/cline-kanban`（只读） | 第一宿主；M0–M2 骨架与可复制的 store / 漏斗 / transcript 读取 / lane 布局 |
| `~/Documents/GitHub/deepseek-harness`（只读） | 目标宿主；接口要镜像的 seam（subagent fork-in-process、session-projection、turn 事件） |
