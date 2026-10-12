# Installation guide

These steps build the active Electron desktop app. The retained legacy backend is not started by these commands.

## 1. Prerequisites

- Node.js **22 LTS**, npm and Git on `PATH`.
- A graphical desktop session; Windows is locally tested.
- Internet access for dependencies and external providers.
- A provider API key with appropriate project access/credits, or a separately installed Ollama service with local models.

Check in PowerShell:

```powershell
node --version
npm --version
git --version
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` instead. No execution-policy change is needed.

## 2. Clone and install

```powershell
git clone https://github.com/sarpanch132/crux-ai-desktop-.git
cd crux-ai-desktop-
npm ci
npm ci --prefix frontend
```

Both lockfiles are required. Root dependencies supply Electron and its services; frontend dependencies supply the UI. Do not separately install `electron/package.json` or the dormant backend. Use a writable folder and do not copy another machine's dependencies or credentials.

## 3. Run

```powershell
npm run dev
```

This starts Vite on strict port 5173, compiles Electron in watch mode and launches the desktop when ready. Keep the terminal open; Ctrl+C stops development.

## 4. Configure a provider and model

1. Choose a real project folder.
2. Open Settings and select a provider.
3. Enter the API key, save the connection and follow its native confirmation.
4. Wait for model verification; passing candidates appear progressively.
5. Choose a verified model or use Auto to test a bounded set.
6. Optionally run Test Connection on the saved configuration.
7. Return to chat; its model selection shares Settings.

Named presets use their endpoint; only Custom asks for a base URL. Ollama normally needs no key but requires its installed service/models. `.env.example` does not configure the active desktop provider. Do not place keys in source files or public issues.

Catalog discovery alone does not prove inference access. Verification uses real minimal chat requests and can consume credits. Cancel, Resume and Retest are available; rate limits pause scans and authentication/account quota failures stop them. Passing status expires and is not a permanent availability guarantee.

OpenRouter's `openrouter/free` appears only after a successful test and can route to different underlying models. Missing failed/untested models are intentional. Test Connection is a diagnostic, not a required chat gate.

## 5. Use Plan / Code / Debug

Plan inspects without mutations, Code implements the saved plan, and Debug must reproduce a failing check before fixing it. Mode changes retain context but may revoke approvals. Start with Medium access and review tool requests before allowing host commands.

Workspace details contain files, changes, problems, test evidence and terminal output. File checkpoints are conflict-aware editing recovery, not complete shell/OS rollback.

The current loop can reach its step limit; robust execution-manager continuation remains pending. Do not assume restarting chat automatically resumes pending actions exactly once.

## 6. Manage agents and skills

Open Agents & Skills, create a name/handle/instructions and select allowed tools or integrations. New agents default to read-only; skills do not grant permissions.

For a public skill, use the drawer or ask in chat:

```text
Install this skill: https://github.com/owner/repository/tree/main/skills/example
```

Root URLs support unique nested discovery. Ambiguous roots need an explicit `SKILL.md` folder. Review the pinned source, file count and destination confirmation. Supporting scripts are not executed during import.

Profiles use Electron per-user application data, typically `%APPDATA%\Crux AI` on Windows. Skills are under `agent\skills\imports\<id>\SKILL.md`. Do not commit profiles or install inside `app.asar`.

## 7. Run checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

The active Node suite builds Electron before testing. Fixtures cover tools, permissions, sessions, routing, imports, provider failures and structured responses; they do not demonstrate live account credits or model quality.

For the development desktop smoke test, run these in two terminals:

```powershell
# Terminal 1
npm run dev:frontend
```

```powershell
# Terminal 2, same repository
npm run build:electron
npm run test:runtime
```

The latest native structured-action desktop check has a known Debug/step-limit regression. Static/service success does not establish that this regression is resolved.

## 8. Build a Windows application folder

```powershell
npm run build
node scripts/package.cjs release/local-build
```

Windows x64 executable:

```text
release\local-build\Crux AI-win32-x64\Crux AI.exe
```

Keep the complete application folder, including `resources` and runtime libraries. The executable alone is not standalone. Packaging targets the host OS/architecture and excludes source maps, environment files, profiles and test artifacts.

Existing destinations are not overwritten. Use another subfolder, such as `release/local-build-2`. Alternatively, `npm run package` builds to the default `release/` destination if it is absent. No signed installer or automatic update deployment is produced.

Test a package using an isolated fixture profile:

```powershell
$env:CRUX_TEST_EXECUTABLE = (Resolve-Path '.\release\local-build\Crux AI-win32-x64\Crux AI.exe').Path
node tests/electron-smoke.cjs --packaged
Remove-Item Env:CRUX_TEST_EXECUTABLE
```

Add `--native-actions` to exercise native structured fixtures; the current Debug failure is noted above.

## 9. Troubleshooting

| Symptom | Action |
| --- | --- |
| Node/npm/Git missing | Install prerequisites and reopen the terminal to refresh PATH. |
| PowerShell blocks npm | Use `npm.cmd`. |
| Install fails | Check Node 22, connectivity/proxy and the correct directory for each lockfile. |
| Port 5173 busy | Free the port or stop the development server you own; preserve unrelated processes. |
| Missing compiled entry | Run `npm run build:electron` or `npm run dev`. |
| Empty model list | Inspect provider/key, verification progress and failure details. |
| Authentication/model denied | Save a correct provider key and choose a successfully verified model. |
| Rate limit | Respect the retry deadline, then resume/retest. |
| Insufficient quota | Check API billing/project/account limits; chat subscription is not API-credit evidence. |
| Invalid action output | Choose reliable structured tools; bounded repairs stop safely on failure. |
| 24-step limit | Inspect changes/errors; the execution-manager fix is pending. Raising the limit alone does not solve repetition. |
| Ambiguous skill import | Use an explicit GitHub tree/blob skill path. |
| Package folder exists | Select a new release subfolder. |
| Docker unavailable | Deliberately configure Linux Docker/cached `node:22`, or use explicitly approved host execution. |
| Linux Electron fails | Supply graphical session and distribution desktop libraries; Linux/macOS acceptance is not locally established. |

Back up profiles before removing sessions. Review logs/artifacts for private context before sharing.
