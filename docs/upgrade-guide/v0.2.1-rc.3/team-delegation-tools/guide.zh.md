---
kind: upgrade-guide
description: "Team 成员不再继承 Web preset 或外层组合中的普通 subagent 委派工具。"
---

# Team 成员使用 teammate 委派

[English](guide.md) | 中文

## 变更

Team bundle 禁用 base 中的工具后，Web standard/PTC preset 仍可能暴露 `subagent`、`subagent_fork` 和 `list_subagent_models`。Team 成员作用域现在会隐藏这些继承的工具以及普通子代理控制工具。Lead 和 teammate 继续拥有 Team 工具；`interrupt: false` 也会隐藏继承的普通 `interrupt_agent`。禁用 Team 工具后恢复继承的定义。profile 名称和持久化 Session 格式均未改变。

## 迁移

1. 更新在 Team 内调用普通委派工具的指令或脚本。Lead 使用 `spawn_teammate`，并选择 `context: fresh` 或 `context: fork`；团队消息使用 `list_agents` 返回的成员目标。
2. 如果需要普通 subagent 委派，在该 profile 中禁用 Agent Teams bundle。SDK profile 变更仍需重启运行时。
3. 启动新的 Team 会话，确认 `spawn_teammate` 可用，而 `subagent`、`subagent_fork` 和 `list_subagent_models` 不再出现。teammate 同样遵循此规则。
