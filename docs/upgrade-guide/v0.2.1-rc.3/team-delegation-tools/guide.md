---
kind: upgrade-guide
description: "Team members no longer inherit ordinary subagent delegation tools from Web presets or enclosing compositions."
---

# Team members use teammate delegation

English | [中文](guide.zh.md)

## Change

Web standard/PTC presets could expose `subagent`, `subagent_fork`, and `list_subagent_models` after the Team bundle disabled their base rows. Team member scopes now hide these inherited tools and ordinary child controls. Team tools remain available on the Lead and teammates; `interrupt: false` also hides an inherited ordinary `interrupt_agent`. Disabling the Team tools restores the inherited definitions. No profile name or persisted Session format changes.

## Migration

1. Update instructions or scripts that call ordinary delegation tools inside a Team. The Lead uses `spawn_teammate` with `context: fresh` or `context: fork`; team messaging uses member targets returned by `list_agents`.
2. If ordinary subagent delegation is required, disable the Agent Teams bundle for that profile. SDK profile changes still require a runtime restart.
3. Start a new Team session and confirm that `spawn_teammate` is available while `subagent`, `subagent_fork`, and `list_subagent_models` are absent. The same rule applies to teammates.
