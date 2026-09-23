# Lisply Backend Requirements

This document outlines the requirements for any Lisp-based program to
become a "Lisply-compliant" backend for use with the MCP (Model
Context Protocol) wrapper implemented by this repository. Compliant
Lisply backend Lisp environments enable direct AI-assisted symbolic
programming, through protocols defined in this document.

## Core Requirements

### 1. Some kind of Lisp

It should be a [Lisp](https://common-lisp.net/). What is a Lisp? Well
for our purposes let's say a Lisp is a program which can accept
_expressions_ in some known syntax, and can _evaluate_ the expression
to produce possibly some output and probably one or more _return
values_. So, strictly speaking, according to our rather loose
definition, we're really talking more about a
[REPL](https://common-lisp.net/project/slime/) than a
[Lisp](https://www.paulgraham.com/lisp.html) per se. But you'll have a
better time if the engine behind your
[REPL](https://lisp-lang.org/learn/repl) is indeed a
[Lisp](https://franz.com/products/allegro-common-lisp/).

### 2. HTTP Server Capability

A Lisply backend must provide an HTTP server that exposes the
following endpoints:

- `/lisply/ping-lisp`: Simple ping endpoint for availability checks
- `/lisply/lisp-eval`: Endpoint for evaluating Lisp expressions
- `/lisply/tools/list`: Endpoint that returns a list of available tools

Note: The endpoint prefix (`/lisply/`) can be configured in the MCP
wrapper, but backends should support this as the default.

### 3. Lisp Evaluation Protocol

The backend must support Lisp code evaluation through the
`/lisply/lisp-eval` endpoint with the following characteristics:

- **Request Format**: HTTP POST accepting JSON payload with:
  ```json
  {
    "code": "Lisp code to evaluate",
    "package": "Optional package name"
  }
  ```

- **Response Format**: JSON response with the following structure:
  ```json
  {
    "success": true,
    "result": "Result of evaluation",
    "stdout": "Any stdout output generated",
    "package": "Optional: the package the code was read and evaluated in"
  }
  ```

  `package` is optional.  When present, the wrapper appends it to the
  tool's text result (`..., Package: GDL-USER`) the way a REPL prompt
  shows where the user is, so an agent never needs an `in-package`
  form.  A backend given a `package` it cannot find must answer with
  `success: false` and an error, never evaluate in some other package.
  
  Or in case of error:
  ```json
  {
    "success": false,
    "error": "Error message"
  }
  ```

### 4. Tool Definitions

The backend must expose a list of its capabilities through the
`/lisply/tools/list` endpoint, which returns a JSON object with the
structure:

```json
{
  "tools": [
    {
      "name": "lisp_eval",
      "description": "Evaluates Lisp code directly within the Lisply environment",
      "inputSchema": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "description": "The Lisp code to evaluate"
          },
          "package": {
            "type": "string",
            "description": "The package to use for the evaluation (optional)"
          }
        },
        "required": ["code"]
      }
    },
    {
      "name": "ping_lisp",
      "description": "Checks if the Lisply backend is available",
      "inputSchema": {
        "type": "object",
        "properties": {}
      }
    }
  ]
}
```

**Note**: The backend is only expected to implement the `lisp_eval`
and `ping_lisp` tools. The `http_request`, `get_docs` and
`get_docs_list` tools are handled by the MCP wrapper middleware
(mcp-wrapper.js) and should not be implemented or documented by the
backend. The backend is not aware of these tools, as they are an
abstraction provided by the middleware.

## Optional Capabilities

### 1. SWANK Server Support

For enhanced integration with development environments:

- **SWANK Protocol**: Support for connecting via SWANK (Superior Lisp
  Interaction Mode for Emacs) for Lisply backends which support that
  (e.g. Common Lisp based backends)
- **Default Port**: 4200 (internal to container) / 4201 (visible on
  docker host)

### 2. Communication

The middleware speaks to the backend over HTTP only: structured
responses with separate result and stdout fields, as specified above.
This is the one mode a backend implements.

An earlier optional "stdio mode", in which the middleware drove a
backend's native REPL on standard input and output (with the
interactive debugger and incremental output that gave), was removed
together with the middleware's container management; a backend need
not present a REPL on standard I/O for any Lisply purpose.

### 3. HTTPS Support

For secure deployments:

- HTTPS server with valid certificates
- Default port: 9443 (internal to container) / 9444 (visible on docker host)

### 4. Telnet Interface

For legacy access methods:

- Telnet server for direct Lisp interaction
- Default port: 4023 (internal to container) / 4024 (visible on docker host)

## Containerization Support (optional; the wrapper never starts containers)

A backend shipped as a container image should honor these conventions,
so that a deployment tool such as the Basilisk yard can raise it beside
the others.  The wrapper itself never pulls or starts a container; it
calls on one that is already running:

1. **Docker Container**: A Docker image containing the Lisply backend
2. **Service Configuration**: Environment variables to configure service startup:
   - START_HTTP, HTTP_PORT
   - START_HTTPS, HTTPS_PORT
   - START_SWANK, SWANK_PORT
   - START_TELNET, TELNET_PORT

3. **Volume Mounting**: Support for mounting host directories into the container

## Implementation Examples

Currently, there are implementations or planned implementations for:

1. **Gendl**: A full implementation available at [Gendl on GitLab](https://gitlab.common-lisp.net/gendl/gendl)
        with Lisply implementation [here](https://gitlab.common-lisp.net/gendl/gendl/gwl/lisply-backend)
2. **GNU Emacs Backend**: the Readymax ready room's Captain, at
   [github.com/gornskew/readymax](https://github.com/gornskew/readymax),
   `dot-files/emacs.d/sideloaded/lisply-backend/`


## Testing for Compliance

To test a backend for compliance, implement the following checks:

1. Ping test: `GET /lisply/ping-lisp`
2. Tool list retrieval: `GET /lisply/tools/list`
3. Basic Lisp evaluation: 
   ```
   POST /lisply/lisp-eval
   {"code": "(+ 1 2 3)"}
   ```
4. Package specification (for backends that support package-based namespaces):
   ```
   POST /lisply/lisp-eval
   {"code": "(package-name *package*)", "package": "gdl-user"}
   ```

A successful implementation should respond correctly to all these tests.

## Optional: Additional Backend-Defined Tools

Beyond the baseline `ping_lisp` and `lisp_eval`, a backend MAY
advertise additional tools in its `/lisply/tools/list` response. The
wrapper passes these through to the MCP client (with server-name
prefixing) and forwards calls to any tool it does not natively handle
to the backend:

```
POST /lisply/tools/call
{"name": "<tool-name>", "arguments": { ... }}
```

The backend responds with an MCP-style result object, passed through
to the client unchanged:

```json
{"content": [{"type": "text", "text": "..."}]}
```

Content blocks may be of any MCP content type; in particular
`{"type": "image", "data": "<base64>", "mimeType": "image/png"}`
lets a backend return images that vision-capable models consume
directly. On failure, include `"isError": true` and a text block
describing the error.

Backends that do not implement `/lisply/tools/call` simply never
advertise extra tools; the wrapper's native set continues to work
unchanged. Example: Gendl/Genworks-GDL backends advertise a
`render_png` tool (see gendl: gwl/lisply-backend and
gwl-graphics/gwl/source/lisply-render-tool.lisp) which renders
geometry via the standalone drawing system and returns MCP image
content.

### Design Guidance: When to Add a Tool (and When Not To)

The founding principle of Lisply is that `lisp_eval` can do anything:
the backend's full language is the API. Extra tools are justified only
when they provide something `lisp_eval` structurally cannot, never as
vocabulary shortcuts. The test: could an s-expression deliver this
result *in the same form*? If yes, it belongs in eval (and in docs and
examples), not in a tool.

Legitimate reasons for a tool:

- **A different return channel.** `lisp_eval` returns text. A tool can
  return other MCP content types -- e.g. `render_png` returns an image
  block that vision-capable models perceive directly, which no text
  result can achieve.
- **A different trust or availability boundary.** `ping_lisp` works
  when eval is wedged; a search over a prebuilt index queries a
  corpus, not the live image.  How a project provides that index --
  the corpus file, the image label, the merge a console performs --
  is the Lisply corpus contract, `CORPUS.md` beside this file.

Illegitimate reason: convenience wrappers over things eval already
does (`make_box`, `load_system`, ...). Each such tool teaches the LLM
to route around the REPL, eroding the interactive-development
experience that is the point of Lisply. Keep the tool count low and
the eval documentation rich.
