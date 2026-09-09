# CHANGELOG

记录 `EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION`、公开 API（`/core` `/harness-claude-code` `/cli`）与宿主契约（handoff A.13）的变更。宿主升级 = 换 git 依赖的 commit SHA，所以每条都要写清「消费方需要改什么」。

## Unreleased

- R0 脚手架：单包多入口（`./core` `./harness-claude-code` `./harness-codex` `./cli` `./dsh-plugin`）、`prepare` 构建、biome 2.5.12 / vitest 4 / tsc NodeNext 检查链、入口点 smoke 测试。
- 契约常量：`EXPLORATION_THREAD_GRAPH_SCHEMA_VERSION = 1`；作业 env 变量名 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB`。
