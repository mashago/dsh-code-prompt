// dsh-code-prompt v0.1.0
//
// Purpose: shadow selected built-in tools per agent and replace their
// model-facing descriptions with DSH-specific guidance.
//
// Why this shape: a global prompt section cannot change a tool's schema.
// The tools registry lets a scoped registration shadow a global one with the
// same name, so this plugin listens for agent/created and re-registers each
// target through agent.ctx. Execution, parameters, and output declarations
// are preserved by spreading the original definition.
//
// The plugin is mounted globally (top-level profile row / --patch insert).
// It affects every agent, including subagents. Missing tools are skipped.

export const name = 'dsh-code-prompt'
export const inject = ['systemPrompt', 'tools']

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RULES = [
  '# Engineering rules',
  '',
  '- Do not add features, refactors, or "improvements" beyond what the task asks for. A bug fix does not need surrounding cleanup.',
  '- Do not create helpers, utilities, or abstractions for one-time operations; three similar lines are better than a premature abstraction.',
  '- Do not add error handling, fallbacks, or validation for scenarios that cannot happen; validate only at system boundaries.',
  '- Before claiming completion, run the verification. If you cannot run it, say so explicitly; never present unverified work as done, and report failures with their output.',
  '- When an approach fails, read the error and diagnose before switching tactics; do not retry the same failing action blindly.',
  '- If several tool calls are independent, issue them in parallel in one response; run them sequentially only when later calls depend on earlier results.',
  '- Before destructive or hard-to-reverse actions (deleting files or branches, overwriting uncommitted work, force-pushing, reset --hard, dropping data, killing processes, sending or posting externally), ask the user for confirmation unless the action was explicitly authorized for this exact scope. A previous approval does not extend to a new context or a wider scope.',
  '- Keep user-facing text short and direct: lead with the answer or action, and include only what the user needs to understand.',
  '- Prefer editing an existing file over creating a new one; do not rewrite a whole file for a targeted change.',
].join('\n')

/*
 * Official DSH 0.2.2-rc.3 tool descriptions (baseline for review).
 * If upstream changes these, review and update DESCRIPTIONS below.
 *
 * bash:
 * Execute a bash command (`bash -c`) and return its stdout/stderr. Each call
 * runs in a fresh shell; pass `workdir` instead of using `cd`. Managed `$DSH_*`
 * variables expose current harness environment facts. Long output is truncated
 * to its tail; the full output is saved to a file whose path is reported when
 * available. Provide `description` before `command` in the arguments. Before
 * any delete or move, verify that the resolved absolute target path is the
 * intended one; never run it against a computed path you have not checked. An
 * unset variable expands to an empty string, so guard variables in such paths
 * with `${VAR:?}`. Commands may run under a file sandbox; a blocked file
 * operation is reported as `[sandbox: file access denied under <mode> mode]`,
 * a policy denial: do not retry another way.
 *
 * pwsh:
 * Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr.
 * Each call runs in a fresh pwsh process; pass `workdir` instead of using `cd`.
 * Paths use native Windows form (`C:\...`); read environment variables with
 * `$env:NAME`. Managed `$env:DSH_*` variables expose current harness
 * environment facts. Long output is truncated to its tail; the full output is
 * saved to a file whose path is reported when available. On Windows a
 * force-killed command settles as `[exit code: 1]` without a signal marker —
 * treat it as an interruption, not a command failure. Provide `description`
 * before `command` in the arguments. Before any delete or move, verify that the
 * resolved absolute target path is the intended one; never run it against a
 * computed path you have not checked. Do not assign to automatic variables such
 * as `$HOME`; variable names are case-insensitive, so `$home` is the same
 * read-only variable. Commands may run under a file sandbox; a blocked file
 * operation is reported as `[sandbox: file access denied under <mode> mode]`,
 * a policy denial: do not retry another way. Under the Windows sandbox,
 * read-only pwsh runs in ConstrainedLanguage mode; .NET static calls,
 * Add-Type, COM, and reflection may fail, and named-pipe stdio capture may
 * fail with EPERM — escalate once or restructure, do not retry another way.
 *
 * read:
 * Read a UTF-8 text file and return line-numbered content.
 *
 * edit:
 * Edit an existing UTF-8 text file by replacing literal text.
 *
 * write:
 * Create or fully replace a UTF-8 text file.
 */

const DESCRIPTIONS = {
  bash: [
    'Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell; pass `workdir` instead of using `cd`, and prefer absolute paths. Quote paths that contain spaces. Managed `$DSH_*` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Provide `description` before `command` in the arguments.',
    '',
    'Use dedicated tools for file work: read instead of cat/head/tail/sed, edit instead of sed/awk, glob instead of find, grep instead of grep/rg. Reserve bash for shell-only operations such as builds, tests, git, and process control.',
    '',
    'When issuing multiple commands:',
    '- If the commands are independent, issue multiple bash calls in parallel in one response.',
    '- If they depend on each other, chain them with `&&`; use `;` only when earlier failures do not matter.',
    '- Do not separate commands with newlines (newlines are fine inside quoted strings).',
    '',
    'For long-running work, use `run_in_background`; you are notified when the job finishes. Do not poll or sleep on it; continue independent work and collect the result with `job_output` when needed. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.',
    '',
    'For git: do not commit or push unless the user asks; never skip hooks with `--no-verify` to manufacture a passing check.',
  ].join('\n'),
  pwsh: [
    'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. Each call runs in a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment variables with `$env:NAME`. Managed `$env:DSH_*` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. Provide `description` before `command` in the arguments.',
    '',
    'Use dedicated tools for file work: read instead of Get-Content, edit instead of Set-Content/-replace, glob instead of Get-ChildItem -Recurse for discovery, grep instead of Select-String. Reserve pwsh for shell-only operations such as builds, tests, git, and process control.',
    '',
    'When issuing multiple commands:',
    '- If the commands are independent, issue multiple pwsh calls in parallel in one response.',
    '- If they depend on each other, chain them explicitly in one command; PowerShell 7 supports `&&` and `||`, but Windows PowerShell 5.1 (the fallback when pwsh 7 is absent) does not — use `;` and check `$LASTEXITCODE` there.',
    '- Prefer one command per call; do not rely on newline-separated commands.',
    '',
    'For long-running work, use `run_in_background`; you are notified when the job finishes. Do not poll or sleep on it; continue independent work and collect the result with `job_output` when needed. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.',
    '',
    'Under the Windows sandbox, read-only pwsh runs in ConstrainedLanguage mode: .NET static calls, Add-Type, COM, and reflection may fail; named-pipe stdio capture may fail with EPERM. Escalate once or restructure the command; do not retry another way.',
    '',
    'For git: do not commit or push unless the user asks; never skip hooks with `--no-verify` to manufacture a passing check.',
  ].join('\n'),
  read: [
    'Read a UTF-8 text file and return line-numbered content.',
    '',
    'Use offset and limit to read a line range or continue a large file. Read a file before editing it; never claim to have inspected a file you have not read. Do not re-read a file you already read unless it changed or you need a different range. The line-number prefix is display-only; do not include it in old_string.',
  ].join('\n'),
  edit: [
    'Edit an existing UTF-8 text file by replacing literal text.',
    '',
    'Read the file first. `old_string` must match the file exactly, including indentation and whitespace, and must be unique unless `replace_all` is true; include enough surrounding context to make it unique. Do not include the line-number prefix from read output. Prefer edit over write for targeted changes; do not rewrite the whole file. If the edit fails, re-read the relevant range and adjust rather than guessing.',
  ].join('\n'),
  write: [
    'Create or fully replace a UTF-8 text file.',
    '',
    'Read an existing file before overwriting it; prefer edit for targeted changes. Use write only for a new file or a complete replacement, and provide the full final content.',
  ].join('\n'),
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  if (config.rules === true) {
    ctx.systemPrompt.section({
      name: 'dsh-code-prompt:engineering-rules',
      order: 100,
      text: RULES,
      interpolate: false,
    })
  }
  if (config.toolDescriptions !== false) installToolDescriptions(ctx, config)
  if (config.toolResults === true || (typeof config.toolResults === 'object' && config.toolResults !== null)) {
    installToolResultShaping(ctx, config.toolResults)
  }
  if (config.environment === true) installEnvironmentContext(ctx)
}

function installToolDescriptions(ctx, config) {
  const overrides = { ...DESCRIPTIONS, ...(config.descriptions ?? {}) }

  const installed = new WeakMap()
  const install = agent => {
    const tools = agent?.ctx?.tools
    if (tools === undefined) return
    // The agent object is the scope key (`scopeOf(agent.ctx) === agent`);
    // using it directly avoids importing a second dsh-scope instance.
    const scope = agent
    let done = installed.get(agent)
    if (done === undefined) {
      done = new Set()
      installed.set(agent, done)
    }
    for (const [toolName, description] of Object.entries(overrides)) {
      if (typeof description !== 'string' || description.length === 0) continue
      if (done.has(toolName)) continue
      const original = tools.get(toolName, scope)
      if (original === undefined) continue
      tools.register({ ...original, description })
      done.add(toolName)
    }
  }

  // Headless registers tools globally before agent/created; web presets may
  // register scoped tools later. agent/pre-step runs after the preset
  // composition and before prompt assembly, so it is the fallback.
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/pre-step', (payload, next) => {
    install(payload.agent)
    return next()
  })
}

// B3: session-level environment facts that DSH does not already inject.
// The working directory is already provided by `working-directory:current`;
// this adds platform, OS, shell, and whether the directory is inside a git
// repository. Git state is recomputed per assembly so a mid-session `git init`,
// `git clone`, or `.git` removal is reflected; platform/OS/shell are static.
function installEnvironmentContext(ctx) {
  ctx.systemPrompt.context({
    name: 'dsh-code-prompt:environment',
    order: 105,
    interpolate: false,
    text: context => {
      const session = context.agent?.session
      if (session === undefined) return ''
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined) return ''
      return environmentText(workingDirectory.get(session))
    },
  })
}

function environmentText(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const osVersion = process.platform === 'win32'
    ? `Windows ${os.release()}`
    : `${os.type()} ${os.release()}`
  const lines = [
    'Current environment:',
    `- Platform: ${process.platform}`,
    `- OS version: ${osVersion}`,
  ]
  const shell = shellName()
  if (shell !== '') lines.push(`- Shell: ${shell}`)
  const root = gitRoot(cwd)
  lines.push(root === undefined
    ? '- Git repository: false'
    : `- Git repository: true (root: ${JSON.stringify(root)})`)
  return lines.join('\n')
}

function shellName() {
  // dsh-base composes tool-pwsh on win32 and tool-bash everywhere else.
  if (process.platform === 'win32') return 'pwsh'
  const shell = process.env.SHELL
  return typeof shell === 'string' && shell.length > 0 ? path.basename(shell) : ''
}

function gitRoot(cwd) {
  let dir = path.resolve(cwd)
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// B2: shape the model-visible tool result text without changing tool
// behavior. `accept` can replace content but cannot change `isError`; a
// non-zero bash exit therefore stays `isError: false`, matching DSH's
// existing shell contract. Both transforms are text-only and reversible.
function installToolResultShaping(ctx, value) {
  const options = value === true
    ? {}
    : (value !== null && typeof value === 'object' ? value : {})
  const editNoMatch = options.editNoMatch !== false
  const shellExitFront = options.shellExitFront !== false && options.bashExitFront !== false
  if (!editNoMatch && !shellExitFront) return

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    try {
      const content = decision.content ?? result.content
      const shaped = shapeContent(content, exec, result, { editNoMatch, shellExitFront })
      return shaped === content ? decision : { ...decision, content: shaped }
    } catch {
      return decision
    }
  })
}

function shapeContent(content, exec, result, options) {
  if (!Array.isArray(content) || content.length !== 1) return content
  const block = content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return content

  let text = block.text
  let changed = false

  if (options.editNoMatch && exec.name === 'edit' && result.isError) {
    const match = text.match(/^Error: old_string was not found in "(.+)"$/)
    if (match !== null) {
      text = `Error: old_string was not found in "${match[1]}". The submitted text does not appear in the current file; do not repeat it.\nRe-read the file and copy an exact substring that exists (including indentation and whitespace), then retry.`
      changed = true
    }
  }

  if (options.shellExitFront && (exec.name === 'bash' || exec.name === 'pwsh') && !result.isError) {
    const match = text.match(/\[exit code: (-?\d+)\]\s*$/)
    if (match !== null && match[1] !== '0') {
      const body = text.slice(0, match.index).replace(/\s+$/, '')
      text = body.length > 0
        ? `[exit code: ${match[1]}]\n${body}`
        : `[exit code: ${match[1]}]`
      changed = true
    }
  }

  if (!changed) return content
  return [{ ...block, text }]
}