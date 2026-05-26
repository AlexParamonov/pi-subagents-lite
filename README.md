# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Lightweight sub-agents for [pi](https://pi.dev). A focused fork of [pi-subagents](https://github.com/tintinweb/pi-subagents) with reduced surface area — spawn specialized agents with isolated sessions, tools, and models.

## Features

- **Agent tool** — spawn foreground or background sub-agents with `Agent({ prompt, description, agent, run_in_background, ... })`
- **Auto-delivered results** — background agents notify you on completion, no polling needed
- **steer_subagent** — inject messages into running agents mid-execution
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter
- **Turn limits** — soft limit with wrap-up warning, then hard abort
- **Per-model concurrency** — configurable slot limits per model
- **Stealth tools** — minimal prompt footprint (`.description`), no promptSnippet/guidelines

## Install

```bash
# Global
pi install npm:pi-subagents-lite

# Project-local
pi install -l npm:pi-subagents-lite

# Try without installing
pi -e npm:pi-subagents-lite

# From git
pi install git:github.com/AlexParamonov/pi-subagents-lite
```

## Quick Start

```ts
// Spawn a foreground agent
Agent({
  agent: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
})

// Spawn a background agent (result auto-delivered)
Agent({
  agent: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

## Custom Agent Types

Define agents in `.pi/agents/<name>.md` with YAML frontmatter:

```markdown
---
description: Review code for security issues
tools: [read, bash, grep, find]
extensions: false
skills: false
max_turns: 5
---

You are a security review specialist. Analyze code for vulnerabilities,
focusing on injection flaws, auth bypasses, and insecure defaults.
```

## Commands

- `/agents` — Management menu: model settings, concurrency, running agents, agent types, agent briefing
- `/steer` — Steer a running agent

## Requirements

- Node.js >= 18
- pi >= 0.74.0

## License

MIT
