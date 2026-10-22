# Python SDK example

English | [中文](README.zh.md)

Runnable Python SDK examples over the sole application launcher, `dsh`. The Python client owns JSON-RPC stdio; the selected profile owns the agent composition, persistence, execution policy, and plugins.

## Run the minimal agent

Install `deepseek-harness-sdk`, export a model credential, then supply an isolated Harness home and workspace:

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
python python/sdk/examples/minimal.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

Set `DEEPSEEK_BASE_URL` for a compatible proxy, `DSH_MODEL` for the script's default model, or `DSH_SYSTEM_PROMPT` for the deployment persona. `--model` is the single runtime model selection; no matching environment variable is required. `--profile` can select another SDK-serving profile. The selected home stores the generated `sdk-minimal` profile and uncompressed JSONL session logs under `sessions/`; the script never reads `~/.dsh` implicitly.

The shipped [`@deepseek-ai/dsh-sdk-minimal` bundle](../../../packages/bundle/sdk-minimal/README.md) is the complete explicit Cordis tree for this mode. It exposes exactly:

- owner-scoped persistent `bash` on Linux/macOS or `pwsh` on Windows
- `read_image` for PNG/JPEG/WebP/GIF files, with an image-capable model
- `working_directory` to inspect or change the Session directory

The bundle does not include `dsh-base`, so every additional row is an explicit profile change. Runtime context, text file tools, local instruction discovery, settings, managed credentials, telemetry, Web tools, subagents, and the full default tool roster are absent. The tree retains SDK startup and JSON-RPC serving, one environment-configured DeepSeek adapter, local execution, and JSONL persistence. [Automatic context compaction](../../../packages/bundle/sdk-minimal/README.md#model-experience) summarizes older history through an additional model request while preserving the complete log. SDK prompt text does not execute slash commands.

The persistent PTY can modify any path available to the runtime process, so use a disposable checkout or container.

<a id="compact-a-full-sdk-session"></a>
## Compact a full SDK Session

The [compaction example](compact.py) uses the full `sdk` profile. It reads `README.md` from the selected workspace into a `Session.query()` prompt, sends `/compact` through the same method, then asks a follow-up using the retained context. Each query is paired with `Session.receive_response()`. It uses the same model credentials and `DSH_MODEL` default as the minimal example, and requires an explicit home:

```sh
python python/sdk/examples/compact.py \
  --dsh-home /absolute/path/to/compact-dsh-home \
  --workspace /absolute/path/to/disposable-workspace
```

The script consumes notifications and prints the command id and outcome separately from the model's responses. A failed turn or command stops the example. See [Query and response](../README.md#query-and-response) for completion and error behavior; `minimal.py` retains its `run()` entry and does not enable command execution.

<a id="change-session-permissions"></a>
## Change Session permissions

The [permission example](permission.py) starts the full `sdk` profile with a `workspace-write` default, sends `/permission <preset>`, then submits an ordinary query on the same Session. Supply the preset explicitly:

```sh
python python/sdk/examples/permission.py \
  --dsh-home /absolute/path/to/permission-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --preset read-only
```

The command changes the Session's policy while the printed launch setting remains `workspace-write`. The later query uses the Session's current policy. Bare `/permission` is ordinary text, and unknown presets produce a command error. See [Query and response](../README.md#query-and-response) for result and state semantics.

## Add plugins

Use the runtime wheel's `dsh` command against the same explicit home for persistent profile changes:

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle
```

Use `sdk-minimal` in that command to extend this example, or `sdk` to extend the full base-backed SDK profile. The Python call can also pass additional absolute patch paths in `patches=(...)`; later files win. A selected profile must retain `@deepseek-ai/dsh-sdk-app` or another JSON-RPC server row. The example accepts no complete Cordis file or arbitrary process argv.

The same runtime wheel packages the `web` profile and its frontend assets for direct CLI use: `dsh web` starts that separate application. A Python SDK client cannot select `web` because it has no JSON-RPC server row.

See the [Python SDK tutorial](../../../docs/user/guide/python-sdk.md) and [SDK reference](../README.md).
