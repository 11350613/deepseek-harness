# Agent Note: Install failures keep their diagnostics in the dialog

Status: implemented

English | [中文](2026-10-28-plugin-install-failure-diagnostics.zh.md)

## Problem

A failed plugin installation could show the generic sentence "Something went wrong during the install; the details say what" while its expanded details showed only "No output". The dialog rendered the live install-log stream and the failure kind, and the two Host diagnostics that explain such a failure never entered that stream. A pnpm run that printed nothing had its diagnostic (`result.shortMessage`, or `pnpm failed` as the fallback) written to the complete log and the returned result but never streamed, so the dialog's terminal stayed empty. The GitHub connection check that stops an installation before pnpm runs kept its captured output only in `packageResult.output`. The Client also ignored the settled result's `packageResult.logPath` and `stage`, so a failure with recorded diagnostics offered no path to the complete log and could not say that a finished installation failed while the bundle was being activated.

## Decision

**The install-log stream carries the Host diagnostic of every run the dialog shows.** A pnpm run that fails without printing anything streams the diagnostic the Host records for it, so the complete log and the dialog show the same text. The GitHub connection check reports the exact `git … ls-remote` command line it ran; when its network failure or timeout stops the installation, `installBundle` emits that command, the captured output, and the failure's exit status as the installation's only install-log run under the caller's request id. A check failure the installation survives streams nothing. A timed-out check has no exit code of its own, so its run settles without one instead of the exit status the timeout coerced.

**The failed screen keeps what the settled result reports, not only the live stream.** `InstallState` holds the settled `packageResult.logPath` and the details name it as the complete log. `InstallState['failure'].stage` (from the already-reported `ChangeResult.stage`) adds the sentence that the installation finished and enabling the bundle failed. Details without a streamed run say the installation produced no terminal output instead of "No output" under an install-location line that had no run to name. The generic sentence names the failed install command.

No wire type, public export, or config key is added: `ChangeResult.packageResult.logPath`, `ChangeResult.stage`, and `packageResult.timedOut` already carry these facts to every consumer. The check's command line is a module-local `GithubConnectionFailure` in `github-connection.ts`.

## Alternatives considered

**Have the Client synthesize a terminal run from `packageResult.output`.** Rejected: the install-log stream would stay incomplete for every other reader, including the agent tool and the complete Host log, and the dialog would carry two notions of a run — one streamed, one rebuilt from the result.

**Render `packageResult.output` as a separate Host-diagnostic block.** Rejected: it duplicates the terminal surface with a second styling and copy path, and the failing check's command line would still be missing.

**Add a failure-stage field to `ChangeResult`.** Rejected: `stage` already names installation and activation, and only activation needed its own sentence; a second stage vocabulary would make every consumer learn two fields for one fact.

**Keep the generic sentence and rely on the details.** Rejected: the empty details panel this fixes was exactly what the sentence pointed at, so the sentence must not promise diagnostics the dialog does not show.

## Consequences

- A failed installation always offers something to act on: a pnpm diagnostic for a silent failure, the failing Git command and its output for a GitHub connection failure, the complete log path, and a sentence naming the failed step when activation failed after a finished installation.
- The generic sentence becomes "The install command failed; the details say why" in every dictionary.
- A GitHub connection failure reports `timedOut`, and its streamed run settles without an exit code.
- No new configuration, wire field, or public package export.

## Related

[Guided plugin installation](../architecture/2026-09-15-guided-plugin-installation.md) owns the install dialog's screens, the pre-install spec check, and the failure classification; this note extends its failed screen and install-log stream.

## Testing

- `packages/boot/plugin-manager/tests/operations.spec.ts` pins the no-output diagnostic stream; `github-connection.spec.ts` pins the recorded command line and timeout state; `manager.spec.ts` pins the single streamed check run under the request id, its absent exit code on timeout, and that a check failure pnpm may resolve streams nothing.
- `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` pins the settled log path and stage, including their reset on retry; `components.client.spec.tsx` pins the enabling sentence, the complete-log line, and the no-output sentence.
- `apps/web/tests/plugin-install-github.e2e.ts` expands the details of a real GitHub connection failure and finds the Git command, its output, and the log path; `apps/web/tests/plugin-install-silent-failure.e2e.ts` fails a real installation through a package manager that prints nothing and finds the run's command line, its diagnostic, and the complete log in the details.
