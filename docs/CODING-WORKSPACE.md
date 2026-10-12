# Coding workspace

Crux keeps one project/session state across Plan, Code and Debug. The main chat remains uncluttered; the resizable right workspace provides Files, Search, Changes, Problems, Tests and Activity. The terminal is a collapsible drawer within that workspace. The command palette opens the same views instead of introducing parallel navigation.

## Execution and safety

The existing runtime routes model actions through the same permission gateway used by manual workspace operations. Repository inspection collects bounded metadata, scripts, languages and configuration names. Environment examples contribute variable names only; credential files are excluded from coding context. File navigation is lazy. Symbol and reference searches are lexical, not language-server analysis.

Existing-file edits require an inspected content hash. Targeted replacement requires exactly one match; multi-file patches validate and authorize every path before applying writes. Checkpoints preserve the actual pre-edit contents, including uncommitted user work. Revert refuses to replace subsequent user edits. Partial patch failures attempt recovery, preserve conflicting newer files and report the conflict. This is recoverable application-level editing, not an atomic filesystem transaction.

Command results retain stdout, stderr, working directory, duration, exit code and timeout evidence. Diagnostics parse common TypeScript, ESLint, Python, Rust and runtime failures into Problems with scoped file links. Tests retain actual command output. Debug must reproduce a failing verification before applying a fix, including delegated edits. Completion requires executable saved checks and acceptance evidence for the current file revision. Optional automatic correction and bounded iteration limits remain session settings.

Background process tools own only the processes started by their session, with a maximum of four active processes and a 120-second timeout. Stop and session changes terminate owned processes; another session cannot stop unrelated processes. Background container processes are currently unsupported and do not fall back silently to host execution.

Host commands require explicit execution authorization. Docker isolation is available only when the required local Docker environment and cached image exist; Crux does not silently substitute host execution or install Docker. File checkpoints cover explicit file operations. Arbitrary host command effects are tracked where visible but are not fully recoverable by file checkpoints.

## Interface

The existing monochrome palette, restrained borders and small controls remain. Search, problems, test output and diffs appear only when requested. Settings and provider selection retain their shared saved configuration. The connection diagnostic remains optional and is not a chat gate.

Motion respects reduced-motion preferences. Workspace resizing supports pointer and keyboard input. Controls have accessible names and busy states, and errors stay near the affected action. Narrow layouts use the existing responsive workspace behavior.

Monaco supplies the lazy-loaded code editor, line navigation, parsed problem markers and before/after diff editor. Its workers and language assets are bundled locally. Xterm renders actual terminal history and events; the existing command input and permission flow still execute commands. There is no new interactive PTY backend. Existing Radix primitives, Lucide, Motion, Sonner, Tailwind and cmdk supply the surrounding interface. No graph, rich-text or chart library was added merely for decoration.

## Boundaries

The registry reports unavailable tools honestly. Authenticated GitHub development operations, external search and general MCP execution require adapters that are not configured. Existing GitHub skill installation is separate from those development APIs. Crux does not claim semantic symbol resolution, comprehensive operating-system rollback or successful live provider verification from fixture results.

## Verification

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Coding suites exercise targeted edits, checkpoint recovery, stale-write protection, scoped permissions, metadata exclusion, diagnostics and runtime behavior. `tests/coding-electron.cjs` exercises the actual desktop workspace; screenshots are saved under `tests/artifacts/`. Packaging stages compiled assets and production dependencies into a new directory under `release/`, preserving earlier builds.

Independent desktop verification passed in development and in the final Windows package. It exercised real Monaco typing/save and worker-computed inline diffs, conflict-safe revert, repository search, repeated problem navigation, the Run tests action with actual command execution, and Xterm output. No page errors or worker/CSP errors were observed. The packaged archive's 74 compiled assets match the final build byte for byte; source, tests, documentation, environment files, source maps and user profiles were excluded. Audit evidence is in `tests/artifacts/coding-release-audit.json`.

Docker execution and non-Windows packaged behavior were not exercised. Provider fixtures do not establish successful live paid-model connectivity; external adapters remain explicitly unavailable until configured.

This implementation passed lint, frontend/Electron typecheck, production build and 135 automated tests. Unit evidence: `tests/artifacts/coding-unit-results.txt`. The final Windows release is `release/coding-workspace-final/Crux AI-win32-x64/Crux AI.exe`; its 74 compiled assets matched the final build byte-for-byte. Audit evidence: `tests/artifacts/coding-release-audit.json`.

Development and packaged desktop checks passed actual Monaco editing and worker-computed diffs, conflict-safe revert, repository search, repeated problem navigation, approved test execution and xterm command output. Both recorded zero page, worker or CSP errors. Screenshots: `tests/artifacts/crux-coding-diff.png` and `tests/artifacts/crux-coding-activity.png`.

Live OpenAI success remains unverified: the previously authorized account returned insufficient API quota. No additional paid provider calls were made for these workspace checks. Actual Docker execution and other operating systems were not verified in this Windows environment.
