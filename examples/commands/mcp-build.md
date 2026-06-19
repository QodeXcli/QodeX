---
description: Four-stage guided build of a new MCP server (discovery → schema → scaffold → wire+test)
argument-hint: <server-name> [<one-line description>]
allowed-tools: [mcp_scaffold, read_file, write_file, edit_text, bash, ls, glob]
---
You will guide me through building a new MCP (Model Context Protocol) server in four stages. Arguments: `{{ARGUMENTS}}`.

Parse: the first token is the server name (kebab-case, e.g. `weather-mcp`). Everything after is the one-line description; if omitted, ask me for it.

## Stage 1 — Discovery (do not write any files yet)

Ask me, in one short message:
1. What does this server do? (one sentence)
2. What tools should it expose? (list 1-5 tool names + one-line purpose each)
3. Does it need network/auth? If yes, which env vars carry credentials?
4. Confirmed scaffold target directory? (default `./<name>` under cwd)

WAIT for my answers before continuing. Do not assume; do not invent tools I didn't ask for.

## Stage 2 — Schema

For each tool I confirmed, draft a JSON-Schema-style input shape:
  - `name` (kebab-case)
  - `description` (one line, will appear in the LLM's tool list)
  - input fields: name, type, required?, one-line description
  - output shape (text by default)

Present the schema list back to me. Wait for me to approve or revise.

## Stage 3 — Scaffold

Call the `mcp_scaffold` tool with name + description + chosen dir. After it returns, immediately:
  - `ls <dir>` to confirm what was written
  - Open `src/index.ts` and `src/tools/example.ts`
  - For EACH tool I confirmed in Stage 2 that isn't the example:
      - Create `src/tools/<tool-name>.ts` following the pattern from example.ts
      - Add an import and a dispatch case in `src/index.ts`
      - Add a test in `test/<tool-name>.test.ts` that exercises the handler

If a tool needs network/auth, leave the network call as a TODO with a clear `throw new Error('TODO: implement <name> network call')` so the test surfaces it, and document the env var in the README.

## Stage 4 — Wire + test

Run, in order:
  1. `cd <dir> && npm install`
  2. `npm run build`
  3. `npm test`
  4. Read the `configSnippet` from the scaffold output and tell me to paste it into `~/.qodex/config.yaml` under `mcp.servers`. Do NOT modify `~/.qodex/config.yaml` directly — I will do it.
  5. Tell me to run `/mcp-restart <name>` once I've saved the config.

If any step fails, stop and report exactly which step + the error. Don't paper over failures.

## Guardrails
- Don't invent tools beyond what I confirmed in Stage 1.
- Don't write to `~/.qodex/config.yaml` (it's the user's file; just produce the snippet).
- Don't commit anything; don't push.
