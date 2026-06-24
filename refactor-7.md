- **Status** — REFACTORED
- **Refactoring summary** — Two small simplifications:
  1. **Inline `AgentDetailsOptions` interface** (tool-execution.ts): Replaced a 6-line interface with a single inline type annotation on `buildAgentDetails`. The interface had two booleans and one use site — unnecessary indirection.
  2. **Remove unused `_filename` parameter** (agent-discovery.ts): `parseAgentFile` accepted a filename parameter that was never used in the function body. Removed from the function signature, the call site in `scanAgentFilesInDir`, and all 14 test call sites.
- **Commits** — `44af2c5` refactor: inline AgentDetailsOptions and remove unused _filename param
