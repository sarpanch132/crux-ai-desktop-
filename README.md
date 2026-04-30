# CruX Desktop

CruX Desktop is an Electron-based AI coding workspace that combines a modern desktop UI with code assistance and local development tooling.

## Why This Project Stands Out

- Desktop-first AI developer experience
- Modular architecture across frontend, electron, backend, and shared modules
- TypeScript-first codebase with linting and type checks
- Packaged Windows build pipeline for distribution

## Core Features

- AI-assisted coding workflows
- Multi-model integration support
- Integrated terminal and filesystem tools
- Repository-aware project context
- Production packaging with Electron

## Tech Stack

- React + TypeScript (frontend)
- Electron (desktop shell)
- Node.js + TypeScript (backend/services)
- ESLint + TypeScript checks

## Project Structure

```text
frontend/   React app and UI logic
electron/   Main process and preload scripts
backend/    Services and API layer
shared/     Shared types/constants
tests/      Test suites
```

## Getting Started

```bash
npm install
npm run dev
```

## Quality Checks

```bash
npm run lint
npm run typecheck
```

## Build and Package

```bash
npm run build
npm run package
```

## Release Notes

- Source code is versioned in this repository.
- Windows binaries are published via GitHub Releases.

## License

MIT
