# Crux AI

A local desktop AI coding workspace built with Electron, React and TypeScript. Plan, implement and debug in one persistent project session, with configurable providers, reusable agents and skills, and permission-controlled tools.

## Installation

Requirements: **Node.js 22 LTS**, npm, Git and a graphical desktop session. Windows is the locally tested target.

```powershell
git clone https://github.com/sarpanch132/crux-ai-desktop-.git
cd crux-ai-desktop-
npm ci
npm ci --prefix frontend
npm run dev
```

Open a project folder, select a provider in Settings, save its API key and choose a model that passes verification. Only Custom asks for a base URL. Ollama requires its own installed service and local models.

See the [complete installation guide](docs/INSTALLATION.md) for setup, provider configuration, building an executable, checks and troubleshooting. This repository contains source; dependencies and executable folders are excluded.

## Features

- **Plan / Code / Debug:** shared objective, plan, context, changes, errors and test history. Plan is read-only; Debug reproduces a failure before applying a repair.
- **Coding workspace:** lazy file browsing, Monaco editing/diffs, lexical search, Problems, Tests, Activity and a collapsible terminal output drawer.
- **Guarded edits:** inspected hashes, targeted replacements and conflict-aware file checkpoints preserve user changes.
- **Provider settings:** OpenAI, OpenRouter, Anthropic, Gemini, Groq, DeepSeek, Mistral, xAI, Together AI, Ollama and compatible/custom endpoints.
- **Synchronized model selection:** Settings and chat share the saved provider, credential and model configuration.
- **Real connection tests:** minimal main-process requests using the same provider service as chat, with safe errors, latency and latest-test status.
- **Verified model catalog:** only successful, unexpired chat candidates are selectable. Scans provide progress, cancel, retest and resume; Auto tests a bounded candidate set.
- **OpenRouter free router:** `openrouter/free` is a real tested candidate and appears after success; no fabricated `:free` IDs.
- **Agents & Skills:** editable names, handles, logos, instructions, triggers, allowed tools, attached skills and bounded callable integrations. Invoke enabled definitions with a leading `@handle`.
- **GitHub imports:** install public skills through chat or the management drawer, including unique nested skills discovered from repository-root links.
- **Structured actions:** native provider calls and supported JSON replies normalize into validated tool actions, with at most two repair retries before safe stop.

## Architecture

```text
React UI -> preload IPC -> project/session runtime -> routing
         -> SDLC orchestrator -> shared provider service
         -> response normalization and schema validation
         -> permission gateway/tools -> persisted evidence -> UI
```

The main process owns permissions and execution. Model text and skill instructions cannot grant authority. Completion requires actual checks and acceptance evidence rather than a model claiming success.

```text
frontend/                    React, Zustand, Monaco and xterm UI
electron/main/               Desktop lifecycle
electron/preload/            Narrow renderer bridge
electron/ipc/                Validated handlers
electron/services/aiService.ts Shared provider configuration/requests
electron/services/agent/     Runtime, routing, permissions, tools and skills
scripts/package.cjs          Application packaging
tests/                       Service and desktop fixture checks
docs/                        Setup and workspace documentation
backend/, shared/            Retained legacy scaffolding, not active desktop services
```

## Safety and storage

Medium is the default access level; Restricted and Full are available. Mode, capability, path and operation approvals are enforced in the main process. Destructive operations and broader host execution require authorization. A command working directory is not confinement.

API keys use OS-backed encryption and provider/endpoint scope. Public settings expose key presence, not saved secrets. Configure keys in the application; `.env.example` belongs to legacy scaffolding and does not configure the desktop provider. Selected project context may be sent to your provider.

Skills install under Electron's writable per-user application data in `agent/skills/imports/`, not the project or executable. Imports are pinned to a commit and confirmed; supporting scripts are stored without execution. Limits: 100 files, 1 MiB/file and 8 MiB/package. Ambiguous roots require an explicit skill path; private repositories are unsupported.

## Checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

The active Node suite builds Electron first. Desktop tests use Playwright, isolated profiles and fixture providers; they do not establish live model quality or credits. Historical TypeScript test scaffolds are outside the active suite.

For development desktop checks, run `npm run dev:frontend` in another terminal, then `npm run build:electron` and `npm run test:runtime`.

## Build an executable folder

```powershell
npm run build
node scripts/package.cjs release/local-build
```

On Windows x64: `release/local-build/Crux AI-win32-x64/Crux AI.exe`. Keep the entire application folder together. Packaging refuses to overwrite output; choose a new folder for subsequent builds. This is an application folder, not a signed installer. Do not install dependencies separately in `electron/`.

## Known limitations

- The loop defaults to 24 model steps with a separate 120-action budget. Robust execution checkpoint/resume and repeated-action detection remain unfinished. Persisted sessions and file checkpoints are not a resumable execution manager.
- The latest native-action packaged Debug regression reached the step limit. Service tests do not establish full packaged acceptance; this source snapshot is not a certified production release.
- Verified models may later fail. OpenRouter/free can choose different underlying models with variable structured-output support.
- Catalog tests can consume credits. Rate limits pause scans; authentication/quota failures stop them. API/project credits may differ from subscription balances.
- Browser support is isolated read-only inspection. Interactive browser/computer automation, cloud workers, SSH, scheduling and parallel agent worktrees are not implemented here.
- Search is lexical; file checkpoints cannot undo all shell effects. Xterm displays output without a new interactive PTY backend.
- Optional Docker isolation requires a Linux daemon and cached `node:22` image; Crux does not install Docker or pull images automatically.
- macOS/Linux runtime, signing, installer upgrades and clean-machine validation remain separate work.

Project metadata declares MIT; third-party components retain their own licenses.
