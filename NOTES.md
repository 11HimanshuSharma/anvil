# NOTES

Running log of decisions and experiment outcomes. Newest first.

---

## 2026-08-29 — GO/NO-GO: **GREEN**, against real Chrome WebMCP

`chrome://flags/#enable-webmcp-testing` corresponds to the `WebMCP` feature,
which can be enabled from the command line. So the §1 question was answerable
locally, without deploying:

    CHROME_ARGS=--enable-features=WebMCP  ->  document.modelContext exists

**A tool registered at runtime is callable in the same session, with no reload.**
The full end-to-end suite passes against the native implementation: 37/37,
including "registered without a reload — 8 → 9 tools" and the agent calling the
new tool by name. `npm run test:native` runs it; it is now in CI.

Running against the real thing immediately found three bugs the shim could not:

1. **`execute()` receives no options argument.** The spec declares
   `ToolExecuteCallbackOptions` with a REQUIRED `AbortSignal`; Chrome 152 calls
   `execute(inputObject)` with one argument. `custom.ts` read `options.signal`,
   so **every agent-authored tool failed on its first call** with the opaque
   "Tool was executed but the invocation failed". This was the whole demo.
   Now optional-chained, and the callback type marks `options` optional so the
   compiler forces every call site to cope.
2. **`executeTool` wants a JSON string, not an object.** The spec's IDL says
   `object inputObject`; Chrome follows its own docs. Passing an object fails
   with `UnknownError: Failed to parse input arguments`. `callTool` now sends
   the string form first and falls back to the object form.
3. The earlier `TypeError`-only retry never fired, because Chrome reports both
   mismatches as `UnknownError` DOMExceptions.

`RegisteredTool` came back with exactly the spec's shape:
`annotations, description, inputSchema, name, origin, title, window`.

**Still unverified:** ChatGPT's in-app browser specifically. Chrome is the
reference implementation, not a guarantee about theirs.

---

## 2026-08-28 — Step 1: live-registration go/no-go probe

**Question (build plan §1):** is a tool registered at 2:00:00 callable by the agent at 2:00:05 *without a page reload*? Everything downstream is worthless if the answer is no.

### Built

A single page (`index.html` + `src/main.ts`) that does exactly the four things §1 asks for:

1. Registers `get_workspace_status` (readOnly) at load.
2. One visible button: **Register a second tool**.
3. Clicking it registers `secret_handshake`, which returns `"banana-4417"`.
4. Renders a live list of `await getTools()` names, re-read on every `toolchange`.

Plus three things §1 did not ask for but the rest of the build needs anyway, so they were written once, here:

- `webmcp/context.ts` — feature detection (`document.modelContext` → `navigator.modelContext` → shim) and a mode badge, so a judge on stock Safari sees a working page instead of a blank one.
- `webmcp/shim.ts` — local `ModelContext` that mirrors the spec's *observable* behaviour: `InvalidStateError` on duplicate/empty name, abort-unregisters-and-rejects, `toolchange` dispatched from a task queue rather than synchronously, results JSON round-tripped.
- `webmcp/registry.ts` — the §3.5 serialized registry, with the `.catch()`-at-call-site fix for abort-rejection.

### Local result — GREEN (shim path)

Verified in-browser at `http://localhost:5173`, driving the page, not the internals:

| Check | Result |
| --- | --- |
| Tool registered at load appears in `getTools()` | ✅ 1 tool |
| Button registers a 2nd tool with no reload | ✅ 2 tools |
| `toolchange` fires on every mutation | ✅ counter tracked each register/unregister |
| `executeTool('secret_handshake')` via the agent's own path | ✅ returned `banana-4417` |
| Abort-to-unregister removes it from `getTools()` | ✅ back to 1 tool |
| Calling an unregistered tool | ✅ `NotFoundError`, not a silent success |
| Re-register same name after unregister | ✅ works, returns `banana-4417` again |
| Duplicate name / bad name / empty description | ✅ rejected with readable messages, not bare `InvalidStateError` |
| **Unhandled promise rejections across the whole cycle** | ✅ **0** |

`tsc --noEmit` clean under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. `vite build` clean.

### Local result — the in-app browser has no WebMCP

Mode badge reads `local mode`; `document.modelContext` and `navigator.modelContext` are both absent in the browser used for this pass. So the green above proves **the page's own logic**, not the platform's. The platform half of the question is still open.

### STILL OPEN — the half only a human can run

The actual go/no-go needs the deployed HTTPS URL opened in the **ChatGPT desktop app's in-app browser** on **GPT-5.6 Sol or Terra**:

1. Ask: *"What site tools are available?"* → should list one.
2. Click **Register a second tool** in the page. Do not reload.
3. Ask: *"Call secret_handshake and tell me what it returns."*

| Outcome | Meaning | Action |
| --- | --- | --- |
| Answers `banana-4417` | Live registration works | Build the plan as written |
| Only sees it after a reload | Snapshot-per-navigation | Pivot: approval triggers a soft reload; demo narration changes; product survives |
| Never sees any tool | Deployment/headers wrong | Fix `Origin-Agent-Cluster`, HTTPS, top-level registration first |

**Record the outcome here before writing application code.**

### Decisions taken

- **No `pnpm create vite`.** Hand-rolled scaffold; the generator's boilerplate was all deletion work.
- **Vanilla TS, no framework**, per §3.1 — React StrictMode double-mounts effects and would fire `registerTool` twice with the same name.
- **`registerTool` is not `await`ed to completion.** The plan's §3.5 snippet does `await p`, but a promise that rejects on abort cannot also resolve on success — it stays pending. `await p` would hang forever. The registry races it against a macrotask instead, so synchronous rejections (duplicate name) still surface while successful registrations proceed.
- **`executeTool` is treated as optional.** If a host exposes `registerTool`/`getTools` but not `executeTool`, the in-page Run button falls back to the callback and says so in the log rather than silently pretending it used the agent's path.
- **CSP has no `unsafe-eval` on the app origin.** The sandbox origin (§3.4) will carry it, and only it.
