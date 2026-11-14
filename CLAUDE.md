# Cyborg Whisperer — agent guidance

This file guides Claude Code (claude.ai/code) or other AI agents
working in this repo.  It is deliberately mixed-register: lore nouns
are bound to their referents at first use, then used freely;
commands, identifiers, and warnings never take the voice.

## What this repo is

The upstream home of the Cyborg Whisperer: a Node.js MCP middleware
(the kit whose running instance is a **Protocol Officer** — the crew
member who receives arriving AI agents, schools them in the ship's
ways, and dispatches them to the resident they came to see).  It
presents MCP tools (`lisp_eval`, `http_request`, `ping_lisp`, and
`lisply_search` where the backend carries a document corpus -- called
`skewed_search` until 2026-09-09; the alias was dropped 2026-09-10) to
any MCP client and relays them over HTTP to a Lisply-compliant backend.

Renamed from `lisply-mcp` on 2026-08-28; git history and some
runtime defaults still carry the elder name (see Compatibility
below).  The protocol itself is and remains **Lisply** — that name
did not change.

## Layout

- `scripts/mcp-wrapper.js` — main entry point
- `scripts/lib/` — config, logger, server, utils
- `scripts/handlers/` — per-tool request handlers
- `BACKEND-REQS.md` — the Lisply protocol spec (what a compliant
  backend must implement)
- `CORPUS.md` — the Lisply corpus: how a project provides its
  `lisply_search` index (file format, the `lisply.corpus` image
  label, how a console merges), and `scripts/lisply-index.js`, the
  reference indexer that writes the format.  Content lives with each
  project; the format lives here, with the protocol that promises
  the tool.
- `regression-tests/harness.js` — stdio JSON-RPC regression harness
- `regression-tests/lisply-index-embed.js` — the indexer's embeddings
  companion (CORPUS.md section 7) against a mock embedding server; run
  it after touching `lisply-index.js`.  Companions are built only for
  `:public` corpora: search results reach cloud AI clients.
- `attic/` — the retired container-management subsystem, history only

## Working on it

- The wrapper is a **pure HTTP client**: it never pulls, starts, or
  manages containers.  Container lifecycle belongs to the Basilisk
  yard (`~/projects/basilisk`, `./basilisk up`).  Do not reintroduce
  docker plumbing here.
- After JS edits: `node --check scripts/mcp-wrapper.js` (and any
  touched lib/handler files).
- Regression harness, against a live backend (from inside the ship's
  network the hostnames are room slugs):

```bash
node regression-tests/harness.js --backend-host bridge --http-port 9080
node regression-tests/harness.js --backend-host ready-room --http-port 7080
```

- Quick manual probe of a Lisply backend (default Gendl backend
  published on host port 9081):

```bash
curl -X POST http://127.0.0.1:9081/lisply/lisp-eval -d '{"code": "(+ 1 2 3)"}'
```

## Compatibility contracts — do not sweep these

The following defaults are user-visible contracts.  Changing them is
a versioned behavior decision, never part of a naming or doc sweep:

- default `--server-name`: `lisply-mcp` (feeds MCP tool prefixes)
- default log file: `/tmp/lisply-mcp-wrapper.log`
- the `LISPLY_*` environment-variable prefix
- the `lisply` endpoint prefix and endpoint names

## Trust model

Lisply backends are exposed to the LLM as **trusted sandboxes**: the
wrapper does not restrict Lisp operators, filesystem access, or
subprocesses.  Isolation is the operator's job, at the container
boundary.  Keep tool metadata advertising this (`TRUST_AS_SANDBOX`,
`SANDBOX_NOTE`) intact.
