# dsh-code-prompt

Claude-Code-style prompt, tool-description, and environment-context levers for
DeepSeek Harness (DSH).

`dsh-code-prompt` is a DSH bundle that adds global engineering rules, replaces
the model-facing descriptions of selected tools, and optionally shapes tool
results or injects environment facts. It does not change tool implementations,
parameter schemas, sandbox behavior, or filesystem semantics.

## Features

| Feature | What it does | Default |
|---|---|---|
| A1 Engineering rules | Nine global rules: minimal change, no one-off abstraction, no impossible-scenario defenses, verify before done, diagnose before retry, parallel independent calls, confirm destructive actions, concise output, edit over rewrite | on |
| A2 Tool descriptions | Replaces the model-facing descriptions for `bash`, `pwsh`, `read`, `edit`, and `write` | on |
| B2 Result shaping | Front-loads shell exit codes and adds an edit no-match hint | off |
| B3 Environment context | Adds platform, OS version, shell, and git repository to the session context | off |

A/B/C/D are intervention surfaces used to organize the bundle: A = static prompt
text, B = runtime context and tool results, C = model call parameters, D = tool
implementation. This bundle covers A and the plugin-friendly parts of B; C and D
are outside its scope.

## Install

From npm:

```sh
dsh plugin --profile web add dsh-code-prompt
```

Replace `web` with your profile name if you use another profile.

From a local checkout:

```sh
cd dsh-code-prompt
dsh plugin --profile <profile> add -w .
```

Add `-w` when the profile's `pnpm-workspace.yaml` makes it a workspace root.
The bundle has no runtime dependencies beyond DSH itself.

## Configuration

The bundle installs one profile row:

```yaml
- id: dsh-code-prompt
  config:
    rules: true
    toolDescriptions: true
    toolResults: false
    environment: false
```

When overriding the row yourself, write all four keys. Options:

- `enabled` — set `false` to disable the whole bundle.
- `rules` — enable A1 with `true`.
- `toolDescriptions` — set `false` to disable A2.
- `descriptions` — per-tool replacement text, e.g. `{ bash: '...' }`.
- `toolResults` — B2; `true`, or an object such as
  `{ editNoMatch: true, shellExitFront: true }` (`bashExitFront` is accepted as
  an alias for `shellExitFront`).
- `environment` — enable B3 with `true`.

## Windows

On Windows DSH registers `pwsh` instead of `bash`. A2 ships a PowerShell-specific
description, B2 front-loads pwsh exit codes, and B3 reports `Shell: pwsh`.

PowerShell 7 is recommended but not required. If it is absent, DSH falls back to
Windows PowerShell 5.1: `&&` and `||` are unavailable there, so use `;` and check
`$LASTEXITCODE`. The B3 `Shell:` line names the DSH tool, not the underlying
executable.

## What changes when enabled

The table compares the same DSH and provider configuration with the bundle off
and on. Hard tasks task-05 through task-08, 3 runs per arm:

| Metric | Off | On (A1+A2) |
|---|---:|---:|
| Average added lines | 4.8 | 2.8 |
| Tool calls | 13.8 | 12.7 |
| Input tokens | 6,834 | 6,030 |
| Output tokens | 2,423 | 2,005 |
| Duration | 21.6s | 17.2s |
| Assertions passed | 36/36 | 36/36 |

A1 alone also reduced average added lines to 2.8; A2 alone to 2.9. The combined
arm had the lowest tool-call, token, and time counts. The provided test suites
passed in every arm.

The destructive-action rule was tested separately: before it was added, no run
deleted the test file (15 runs), and DSH tended to fix the real bug directly
without an explicit confirmation step. After it was added, 3/3 runs explicitly
refused the deletion, cited the rule, and fixed the real bug. The sample is
small.

B3 (off by default) was measured on the same hard tasks. In a non-git workspace
with 6 runs per arm, git probing calls fell from 0.29 to 0.00 per run and input
fell 8.6%; in a git repository with 3 runs per arm, probing fell 37% and input
fell 9.7%. Tool-call counts were essentially unchanged (14.21 vs 14.25 in the
non-git round). Keep it off unless the extra context is useful for your
deployment.

B2 (off by default) was tested in two A/B rounds and found no pass-rate or
efficiency gain. The code remains for future models, but it is not part of the
recommended configuration.

These tasks are small and every arm passed; the numbers are directional, not a
benchmark of general coding ability. The A1 numbers above were measured with the
8-rule version; the destructive-action rule was added later and tested on a
dedicated task.

## Compatibility

- DSH `>=0.2.1-rc.1 <0.3.0-0` (`engines.dsh`)
- No runtime dependencies beyond DSH itself
- Node 24+ (as required by DSH)
- No build step; plain ESM

## Upgrading

Replacing the bundle while a session is live can leave that session's agent
scope with the previous tool shadows. Start a new session after an upgrade;
new sessions always see the current descriptions.

## Development

```sh
node --check index.js
npm pack --dry-run
```

Evaluation fixtures and run logs are kept in the development repository, not in
this package.

## License

MIT. This is a third-party bundle, not an official DeepSeek package. It is not
affiliated with Anthropic; Claude Code is a trademark of Anthropic PBC.

## 中文简介

`dsh-code-prompt` 是一个 DSH bundle：9 条全局工程规则、5 个工具的描述替换
（`bash` / `pwsh` / `read` / `edit` / `write`），以及默认关闭的工具结果整形和
环境上下文。它不改工具实现、参数 schema、sandbox 或文件系统语义。

同一 provider 配置下开启 A1+A2 后，硬任务平均新增行 4.8 → 2.8，工具调用
13.8 → 12.7，input 6,834 → 6,030，时长 21.6s → 17.2s；两臂均 36/36 通过。
任务偏简单，数字只作方向参考。