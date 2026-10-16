# Agent Note: Default apply_patch availability

Status: implemented

English | [中文](2026-10-16-default-apply-patch.zh.md)

## Problem

A separate activation overlay prevents ordinary coding sessions from using the multi-file patch capability in the default filesystem tool set.

## Decision

`tool-fs.enableApplyPatch` defaults to `true`, alongside read, write, and edit. Explicit `false` removes the tool and its guidance. Minimal SDK and Web presets, which intentionally exclude text file tools, set it to `false`.

This supersedes the evaluation-gated activation decision in [apply_patch file editing](2026-09-28-apply-patch-file-editing.md). Availability does not assert an improvement in task success or token cost; controlled evaluation remains separate. Observation, version, and sandbox requirements are unchanged.

## Alternatives considered

**Keep activation gated on evaluation.** This retains the extra configuration requirement that default availability removes. The explicit off switch supports comparison runs and deployments that do not want the tool.

## Consequences

Default model requests include another tool schema and its guidance, so recorded request expectations change. Existing write and edit tools remain available. Minimal presets retain their small tool sets, and deployments can opt out without removing filesystem access.
