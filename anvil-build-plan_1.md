# Anvil — Build Plan

**A workspace whose tools are written at runtime, by your agent, with your approval.**

Target: OpenAI WebMCP Challenge. Deadline **Wed Sep 3, 2026, 1:00 pm PT**. Solo build. Today is Fri Aug 28.

---

## 0. The one-paragraph version

Agents suffer from *procedural drift*: you explain your idiosyncratic way of doing something, the agent does it well, and next session it does it slightly differently because prose gets re-interpreted every time it's read. Memory doesn't fix this — prose is the problem. A tool is the opposite of prose: frozen behavior, same input, same output, indefinitely. Anvil is a local-first workspace where, the moment your agent nails a fiddly task, you convert that one-off success into a permanently callable WebMCP tool — the agent writes the code, you approve the behavior, and it's registered live without a reload, a deploy, or an OAuth flow.

**The submission sentence:** every WebMCP demo so far answers "what can a site let an agent do?" with a fixed list the site's developer chose. Anvil makes that list open-ended and authored by the user.

Name alternates if `anvil` is taken on the domain you want: Forge, Toolsmith, Whetstone, Crucible.

---

## 1. GO/NO-GO EXPERIMENT — do this tonight, before anything else

**The entire product rests on one unverified assumption:** that a tool registered at 2:00:00 is callable by the agent at 2:00:05 *without a page reload*. If ChatGPT's built-in browser snapshots the tool list once per navigation instead of reacting to `toolchange`, the emotional center of your demo does not exist.

### Build (target: 90 minutes)

A single static page, deployed to HTTPS, that does exactly this:

1. Registers `get_workspace_status` (readOnly) at load.
2. Has one visible button: **"Register a second tool"**.
3. Clicking it registers `secret_handshake`, which returns the string `"banana-4417"`.
4. Renders a live list of `await mc.getTools()` names, refreshed on every `toolchange` event.

### Test protocol

1. Open the deployed URL in the **ChatGPT desktop app's built-in browser**, on **GPT-5.6 Sol or Terra** (Luna has WebMCP disabled; not available in Enterprise/Edu workspaces).
2. Ask: *"What site tools are available?"* → should list one.
3. Click the button in the page.
4. Without reloading, ask: *"Call secret_handshake and tell me what it returns."*

### Outcomes

| Result | Meaning | Action |
|---|---|---|
| Agent calls it and returns `banana-4417` | Live registration works | Build the plan as written |
| Agent doesn't see it until you reload | Snapshot-per-navigation | Pivot: approval triggers a soft reload, demo script changes, still viable |
| Agent never sees any tool | Deployment/headers wrong | Fix `Origin-Agent-Cluster`, HTTPS, top-level registration before anything else |

Also verify in **Chrome with `chrome://flags/#enable-webmcp-testing`** plus the **Model Context Tool Inspector extension**, which lets you call tools manually and inspect schemas without burning ChatGPT turns.

**Do not write another line of application code until this is green.** Everything downstream is worthless if it fails.

---

## 2. Product decisions (locked)

### 2.1 The workspace domain

The tools need something real to act on or the whole thing reads as a toy sandbox. Ship **a link/reading queue**: items with `url`, `title`, `source`, `tags[]`, `status`, `notes`, `addedAt`.

Why this and not something more impressive: universally relatable, needs zero auth, the data is genuinely messy in ways worth normalizing, and it seeds well. Ship with ~30 pre-loaded items so a judge who opens the URL cold has something to play with in five seconds.

### 2.2 The hero demo tool

The tool the agent proposes on camera: **`find_near_duplicates(threshold)`** — trigram similarity across item titles+urls, returns pairs.

This is the right choice because the *ad-hoc* version is visibly bad (agent pages through `list_items`, eyeballs, misses some, takes 20 seconds) and the *tool* version is instant and exact. The contrast is the argument.

### 2.3 The non-negotiable interaction rule

**The agent supplies the code. The human supplies the prose.**

Code is sandboxed and capability-scoped; it cannot steer the model. Descriptions *are* the steering mechanism — they get loaded into the model's context on every future session — so a model-authored description must never be registered without a human explicitly accepting the wording. This is the answer to the persistent-prompt-injection problem your app otherwise creates.

### 2.4 Approval is behavioral, not textual

Never show "here are 40 lines of JS, approve?" as the primary review UI. That's security theater — the audience who can't stand up an MCP server can't audit JavaScript either.

The review drawer shows, in this order:

1. **What it can touch** — capability chips: `reads your items` / `writes your items` / `reaches the network (domains: …)` / `pure computation`
2. **What it actually did** — dry-run output against 3 real items from the workspace, rendered as a before/after diff
3. **The description you'll be committing to** — editable text field, pre-filled with the agent's draft, flagged as agent-authored
4. **Source** — collapsed `<details>`, for the 5% who want it

---

## 3. Architecture

### 3.1 Stack

- **Vanilla TypeScript + Vite.** Not React.
  - Reason: React StrictMode double-mounts effects in dev, which fires `registerTool` twice with the same name. The second call rejects with `InvalidStateError`. You will lose an hour to this at 1am. Skip it.
  - If you insist on React: register tools from a module-level singleton outside the component tree, never in `useEffect`.
- **`idb`** (~1.5 kB) for IndexedDB.
- **No CSS framework.** Hand-write ~400 lines. Faster than fighting a config.
- Two deployments (see §3.4): `app` origin and `sandbox` origin.

### 3.2 Module map

```
src/
  webmcp/
    context.ts        # feature-detect + shim
    registry.ts       # ToolRegistry: serialized register/unregister/replace
    shim.ts           # local ModelContext implementation for unsupported browsers
  sandbox/
    host.ts           # parent side: iframe lifecycle, RPC, capability enforcement
    protocol.ts       # shared message types
  store/
    db.ts             # idb schema + migrations
    items.ts          # workspace CRUD
    tools.ts          # custom tool persistence
    proposals.ts
    audit.ts
  tools/
    builtin.ts        # 5 workspace tools
    meta.ts           # propose_tool, dry_run_draft, list_available_tools
    custom.ts         # builds a ModelContextTool from a stored ToolDef
  surface/
    entropy.ts        # overlap detection, context cost, retirement candidates
  ui/
    app.ts, items.ts, drawer.ts, surfacePanel.ts, auditLog.ts
sandbox-origin/       # separate deploy
  index.html          # opaque-origin executor
  executor.js
```

### 3.3 Data model

```ts
type Item = {
  id: string; url: string; title: string; source: string;
  tags: string[]; status: 'unread' | 'reading' | 'done' | 'archived';
  notes: string; addedAt: number; updatedAt: number;
};

type Capability = 'read:items' | 'write:items' | 'net';

type ToolDef = {
  name: string;              // /^[A-Za-z0-9_.\-]{1,128}$/
  title: string;
  description: string;       // HUMAN-ACCEPTED text
  agentDraftDescription?: string;  // what the model originally wrote, kept for provenance
  inputSchema: object;       // JSON Schema
  code: string;              // function body: (args, host) => any
  capabilities: Capability[];
  networkDomains: string[];  // exact hostnames, only meaningful if 'net'
  provenance: 'agent' | 'human';
  descriptionAccepted: boolean;  // gate: cannot register while false
  version: number;
  createdAt: number;
  stats: { calls: number; errors: number; lastUsedAt: number | null };
  testCases: { args: object; expectation: string }[];
};

type Proposal = {
  id: string; draft: ToolDef; rationale: string;
  dryRuns: { args: object; ok: boolean; result?: unknown; error?: string; ms: number }[];
  scanFlags: string[];       // injection-scan hits
  overlapsWith: string[];    // existing tool names above similarity threshold
  createdAt: number;
};

type AuditEntry = {
  id: string; ts: number; toolName: string; args: object;
  ok: boolean; result?: unknown; error?: string; durationMs: number;
};
```

IndexedDB stores: `items`, `tools`, `proposals`, `audit`. Version 1, single migration.

### 3.4 The sandbox — cross-origin iframe (this is the important part)

**Key realization:** ChatGPT's browser doesn't *discover tools* inside iframes. That restriction is about tool discovery only. Your tools register on the top-level document; their `execute` handler postMessages into an iframe that runs user code. The iframe registers nothing, so the limitation doesn't apply.

That means you can use a **real** security boundary instead of a soft one.

**Design:**

```html
<iframe
  src="https://anvil-sandbox.example/executor.html"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  hidden></iframe>
```

`sandbox="allow-scripts"` **without** `allow-same-origin` gives the frame an **opaque origin**. Consequences, all of them good:

- No access to your IndexedDB, localStorage, or cookies.
- Any `fetch` it attempts is credential-less and cross-origin — and you delete `fetch` anyway.
- It cannot reach the parent DOM.
- Its only channel out is `postMessage` to the parent, which you fully control.

Compare to a Web Worker: a worker is **same-origin**, so it can reopen IndexedDB and issue credentialed fetches. Deleting globals in a worker is defense-in-depth, not a boundary. Say this plainly in your README — it's the kind of honesty that reads as competence.

**Executor harness (inside the iframe):**

```js
// executor.js — runs at opaque origin
const HOST = new Map(); // pending host RPC calls
let seq = 0;

function makeHost(caps) {
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    HOST.set(id, { res, rej });
    parent.postMessage({ t: 'host', id, method, params }, '*');
  });
  const h = {};
  if (caps.includes('read:items')) {
    h.items = { list: q => call('items.list', q), get: id => call('items.get', id) };
  }
  if (caps.includes('write:items')) {
    h.items = Object.assign(h.items ?? {}, {
      upsert: it => call('items.upsert', it),
      remove: id => call('items.remove', id),
    });
  }
  if (caps.includes('net')) h.fetchJson = (url, init) => call('net.fetch', { url, init });
  h.log = m => call('log', String(m));
  return Object.freeze(h);
}

// Remove obvious ambient reach. Not a boundary — the opaque origin is the boundary.
for (const k of ['fetch','XMLHttpRequest','WebSocket','Worker','SharedWorker',
                 'importScripts','indexedDB','caches','EventSource','navigator']) {
  try { delete self[k]; } catch {}
}

addEventListener('message', async (e) => {
  const m = e.data;
  if (m.t === 'hostResult') {
    const p = HOST.get(m.id); HOST.delete(m.id);
    m.ok ? p.res(m.value) : p.rej(new Error(m.error));
    return;
  }
  if (m.t !== 'exec') return;
  try {
    const fn = new Function('args', 'host', `"use strict";\n${m.code}`);
    const out = await fn(m.args, makeHost(m.capabilities));
    parent.postMessage({ t: 'execResult', id: m.id, ok: true,
      value: JSON.parse(JSON.stringify(out ?? null)) }, '*');
  } catch (err) {
    parent.postMessage({ t: 'execResult', id: m.id, ok: false,
      error: String(err && err.message || err) }, '*');
  }
});
parent.postMessage({ t: 'ready' }, '*');
```

**Parent side (`sandbox/host.ts`) responsibilities:**

- Verify `event.origin === SANDBOX_ORIGIN` on every inbound message. (With `allow-scripts` only, origin serializes as `"null"` — so verify `event.source === iframe.contentWindow` instead. Write this correctly; it's a common bug.)
- **Watchdog:** if no `execResult` within `EXEC_TIMEOUT_MS` (default 3000), destroy the iframe element and recreate it. That's your kill switch — you can't `terminate()` an iframe, you remove it from the DOM.
- **Capability enforcement** on every `host` RPC: re-check the requesting tool's declared capabilities *on the parent side*. Never trust the `caps` the frame claims.
- **Network proxy:** for `net.fetch`, check hostname against `networkDomains` exact-match allowlist, force `credentials: 'omit'`, `redirect: 'error'`, cap response at 256 kB, 5s timeout.
- **Result size cap:** reject results over ~64 kB before they go back to the agent (they land in the model's context).
- Serialize: one execution at a time per frame. Queue the rest.

**Sandbox origin headers:**

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'; frame-ancestors https://anvil.example
X-Content-Type-Options: nosniff
```

`'unsafe-eval'` is required for `new Function`, and confining it to a separate origin is exactly why you're using one. Your main app origin keeps a strict CSP with no `unsafe-eval`.

### 3.5 ToolRegistry — the lifecycle engine

Three spec facts drive this design:

1. **There is no `unregisterTool()`.** The current IDL has only `registerTool`, `getTools`, `executeTool`, `ontoolchange`. You unregister by aborting the `AbortSignal` passed in `registerTool(tool, { signal })`.
2. **Aborting rejects the original `registerTool` promise** with the abort reason → unhandled rejection warnings unless you attach a `.catch(() => {})` to every register promise. Do this immediately, at the call site.
3. **The spec documents an unregister/re-register race.** Aborting and quickly re-registering the same name with a different `inputSchema` is explicitly not protected — an in-flight call can hit the old name with the new schema. Serialize.

```ts
export class ToolRegistry {
  #mc: ModelContextLike;
  #entries = new Map<string, { ac: AbortController; def: ToolDef | null }>();
  #queue: Promise<unknown> = Promise.resolve();

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next as Promise<T>;
  }

  register(tool: ModelContextTool) {
    return this.#enqueue(async () => {
      if (this.#entries.has(tool.name)) throw new Error(`duplicate: ${tool.name}`);
      const ac = new AbortController();
      const p = this.#mc.registerTool(tool, { signal: ac.signal });
      p.catch(() => {});            // abort rejects this later — swallow it
      await p;
      this.#entries.set(tool.name, { ac, def: null });
    });
  }

  unregister(name: string) {
    return this.#enqueue(async () => {
      const e = this.#entries.get(name);
      if (!e) return;
      e.ac.abort();
      this.#entries.delete(name);
      await this.#settle();          // let toolchange land before anything else runs
    });
  }

  async replace(tool: ModelContextTool) {
    await this.unregister(tool.name);
    await this.register(tool);
  }

  #settle() {
    // toolchange fires from a parallel queue; ordering vs other tasks is not guaranteed.
    // Race it against a short timer so we never hang.
    return Promise.race([
      new Promise<void>(r => this.#mc.addEventListener('toolchange', () => r(), { once: true })),
      new Promise<void>(r => setTimeout(r, 50)),
    ]);
  }
}
```

**Validation before every register** (mirror the spec's own rejection conditions so you fail with a good message instead of a bare `InvalidStateError`):

- `name` matches `/^[A-Za-z0-9_.\-]{1,128}$/`
- `description` is non-empty
- `inputSchema` is JSON-serializable, no circular refs
- name not already in `#entries`

### 3.6 Feature detection + shim

```ts
export const mc: ModelContextLike =
  (document as any).modelContext ??
  (navigator as any).modelContext ??      // deprecated in Chromium 150, still present in some builds
  createShim();
```

The shim (~60 lines) implements `registerTool` / `getTools` / `executeTool` / `toolchange` against a local `Map`. Two payoffs:

- Your **in-page "Run" button** exercises the *real* WebMCP code path — `getTools()` then `executeTool()` — instead of calling the JS function directly. Same path the agent uses, so you're testing what ships.
- A judge who opens your URL in stock Safari sees a fully working product with a banner reading *"Running in local mode — connect a WebMCP agent to let it call these tools."* That is worth real points on **Execution**.

Show a small badge in the corner: `native` / `native (legacy navigator)` / `local mode`.

### 3.7 Surface entropy (the differentiator)

Every tool costs context and competes for selection. Chrome's own guidance warns that overlapping tools make the agent worse at picking. A surface that grows by accretion — with names written by a model optimizing for helpfulness, not discriminability — degrades as the user invests more. Month three you have `normalize_company`, `clean_company_name`, and `fix_employer_field`, and the agent picks wrong.

Build a crude but real answer. No embeddings, no API calls:

```ts
// Jaccard over token sets of (name + title + description), plus trigram sim on name.
// score = 0.6 * jaccard(descTokens) + 0.4 * trigram(name)
// >= 0.55  -> flag as overlapping
```

Three UI consequences:

1. **On proposal:** if it overlaps an existing tool, the drawer's primary button becomes **"Extend `existing_tool` with a parameter"** instead of "Approve as new". Consolidation is the default; addition is the escape hatch.
2. **Context cost meter:** `Math.ceil(JSON.stringify({name,description,inputSchema}).length / 4)` tokens per tool, summed, displayed live in the surface panel: *"Your agent carries ~1,240 tokens of tool definitions."*
3. **Retirement:** tools with 0 calls in 14 days get a "retire?" chip. One click aborts the signal and archives the def.

Name this concept **tool surface entropy** in your write-up. Giving the judges a vocabulary they didn't have is how an infrastructure-shaped project wins Creativity.

### 3.8 Security model — write this section of the README carefully

Your app takes the spec's tool-poisoning attack and makes it *persistent and user-blessed*. If the agent reads a poisoned page and then proposes a tool, injected instructions could live in a description loaded into every future session. Address it explicitly or a sharp judge finds it in thirty seconds.

Mitigations, in order of strength:

| Threat | Mitigation |
|---|---|
| Persistent prompt injection via description | Human must accept description text; agent draft shown flagged; `descriptionAccepted` gates registration |
| Malicious code | Opaque-origin iframe, no ambient credentials, capability-gated host RPC, parent-side enforcement |
| Runaway execution | 3s watchdog, iframe destroyed and recreated |
| Data exfiltration | No network capability by default; exact-hostname allowlist; `credentials: 'omit'`; response cap |
| Untrusted output steering the model | Every custom tool registers with `annotations: { untrustedContentHint: true }` — this is precisely what the spec's mitigation section prescribes |
| Agent self-approving | No tool exists that registers a tool. `propose_tool` returns a pending status. There is no code path from an agent call to a live registration. |
| Over-parameterized privacy leak | Schemas are user-visible in the drawer; flag proposals requesting fields unrelated to the workspace |

Set `readOnlyHint: true` for tools with only `read:items`. ChatGPT's site-tools panel displays the split ("3 read, 7 write tools"), so this shows up in the judge's UI for free.

**Injection scanner** — a regex pass on the proposed description, flagging (not blocking): `ignore previous`, `system:`, `<important>`, `you must`, `disregard`, embedded URLs, base64-looking blobs, length over 600 chars, and any second-person imperative aimed at the model. Show hits as amber chips in the drawer.

---

## 4. The tool surface

Keep the built-in surface at **8 tools**. More costs context and hurts selection accuracy.

### 4.1 Workspace tools (5)

| Name | readOnly | Purpose |
|---|---|---|
| `list_items` | ✓ | List items, filterable by status/tag/source, with limit + offset |
| `get_item` | ✓ | Full record by id |
| `search_items` | ✓ | Substring search across title, url, notes |
| `save_item` | | Create or update; upsert semantics on id |
| `remove_item` | | Delete by id |

Write descriptions per Chrome's guidance: distinguish execution from initiation, use positive language, no "don't use this for X". Example:

```js
await mc.registerTool({
  name: "search_items",
  title: "Search saved links",
  description: "Searches the user's saved links by matching text against title, URL, and notes. Returns matching items with their ids, titles, URLs, tags, and status. Use this to find specific items before reading or updating them.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to match. Case-insensitive substring match." },
      status: { type: "string", enum: ["unread","reading","done","archived"],
                description: "Optional filter by reading status." },
      limit: { type: "number", description: "Maximum results to return. Defaults to 20." }
    },
    required: ["query"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query, status, limit = 20 }) => ({ items: await searchItems(query, status, limit) })
}, { signal: ac.signal });
```

### 4.2 Meta tools (3)

**`list_available_tools`** (readOnly) — returns the user's custom tools with names, descriptions, schemas, and call counts. Lets the agent reason about what capabilities already exist before proposing a duplicate. Its description should say so explicitly: *"Call this before proposing a new tool, to check whether a suitable one already exists."*

**`propose_tool`** — the centerpiece. Its description must set expectations correctly or the agent will report success when nothing happened:

> Submits a draft tool for the user to review. **This does not register the tool and does not make it callable.** The user reviews the behavior in the page and approves or rejects it. Returns a proposal id and a pending status. After proposing, tell the user a proposal is waiting for review in the page; do not attempt to call the proposed tool until they confirm approval.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "name":        { "type": "string", "description": "snake_case identifier, 1-128 chars, letters/digits/underscore/hyphen/period only" },
    "title":       { "type": "string", "description": "Short human-readable label" },
    "description": { "type": "string", "description": "What the tool does and when to use it. The user will review and may rewrite this before it is registered." },
    "inputSchema": { "type": "object", "description": "JSON Schema object describing the tool's arguments" },
    "code":        { "type": "string", "description": "JavaScript function body. Receives (args, host). host.items.list/get are available with read:items; host.items.upsert/remove with write:items; host.fetchJson with net. Must return a JSON-serializable value. No DOM, no network except via host." },
    "capabilities":{ "type": "array", "items": { "type": "string", "enum": ["read:items","write:items","net"] },
                     "description": "Request the minimum needed. Pure computation needs none." },
    "networkDomains": { "type": "array", "items": { "type": "string" },
                     "description": "Exact hostnames this tool may reach. Only used when capabilities includes net." },
    "rationale":   { "type": "string", "description": "Why this tool is worth making permanent, in one or two sentences for the user." },
    "testCases":   { "type": "array", "items": { "type": "object",
                     "properties": { "args": { "type": "object" }, "expectation": { "type": "string" } } },
                     "description": "Two or three example calls with what you expect to happen." }
  },
  "required": ["name","description","inputSchema","code","capabilities","rationale"],
  "additionalProperties": false
}
```

**`dry_run_draft`** — executes a pending proposal's code in the sandbox against supplied args and returns the result or a structured error. Does not register. This creates the loop that makes the agent actually good at this: *write → dry-run → see the real error → fix → propose*. Chrome's guidance specifically recommends descriptive errors so the model can self-correct; this is that, made explicit.

Return structured errors everywhere:

```js
return { ok: false, error: "capability_denied", detail: "This tool declared no network capability but called host.fetchJson.", hint: "Re-propose with capabilities including 'net' and networkDomains set, or remove the fetch." };
```

### 4.3 Custom tools

Built from stored `ToolDef` by `tools/custom.ts`:

```ts
function toModelContextTool(def: ToolDef): ModelContextTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: {
      readOnlyHint: !def.capabilities.includes('write:items') && !def.capabilities.includes('net'),
      untrustedContentHint: true,       // authored in-page, not by the site developer
    },
    execute: async (args, { signal }) => {
      const started = performance.now();
      try {
        const value = await sandbox.exec(def, args, signal);
        await audit.record({ toolName: def.name, args, ok: true, result: value,
                             durationMs: performance.now() - started });
        await tools.bumpStats(def.name, { ok: true });
        return value;
      } catch (err) {
        await audit.record({ toolName: def.name, args, ok: false, error: String(err),
                             durationMs: performance.now() - started });
        await tools.bumpStats(def.name, { ok: false });
        return { ok: false, error: 'execution_failed', detail: String(err) };
      }
    }
  };
}
```

Note: **return** structured failures rather than throwing where you can. A thrown rejection surfaces to the agent as a bare failure; a returned error object gives it something to reason about.

Honor the `signal` in `ToolExecuteCallbackOptions` — wire it to the sandbox watchdog so agent-side cancellation actually kills the frame.

---

## 5. Day-by-day schedule

Working backwards from **Wed Sep 3, submit by 6pm PT** (the deadline is 1pm Thursday; treat Wednesday evening as final so Thursday morning is pure buffer).

### Friday Aug 28 — tonight (3h)

- [ ] Repo created, **MIT `LICENSE` at repo root** (GitHub's About sidebar must show "MIT license" — the rules require a detectable license)
- [ ] Vite + TS skeleton, deployed to Vercel/Netlify at a real HTTPS URL
- [ ] Headers configured (§6) — verify `Origin-Agent-Cluster: ?1` in DevTools Network tab
- [ ] **Run the §1 go/no-go experiment**
- [ ] Record the outcome in `NOTES.md`

**Gate:** if live registration doesn't work, decide the pivot tonight, not Tuesday.

### Saturday Aug 29 — full day (8-10h)

Morning:
- [ ] `store/db.ts` — idb schema, 4 object stores, seed 30 items
- [ ] `ui/items.ts` — the workspace list view, add/edit/delete, tag filter
- [ ] `webmcp/shim.ts` + `webmcp/context.ts` + mode badge

Afternoon:
- [ ] `webmcp/registry.ts` — full ToolRegistry with serialized queue and validation
- [ ] `tools/builtin.ts` — all 5 workspace tools with carefully written descriptions
- [ ] `ui/surfacePanel.ts` — live list of `getTools()`, re-rendered on `toolchange`, with the context-cost meter

**Acceptance:** in ChatGPT's browser, ask the agent to *"find my unread links about databases and mark two of them as reading."* It works end to end using only built-ins.

### Sunday Aug 30 — full day (8-10h)

Morning:
- [ ] Second deploy: sandbox origin, `executor.html` + `executor.js`, CSP headers
- [ ] `sandbox/host.ts` — iframe lifecycle, `event.source` verification, RPC dispatch, watchdog + destroy/recreate, execution queue
- [ ] Capability enforcement on the parent side, network proxy with allowlist

Afternoon:
- [ ] `store/tools.ts` — persistence
- [ ] `tools/custom.ts` — ToolDef → ModelContextTool, stats, audit
- [ ] Manual tool authoring UI (you need this to test before `propose_tool` exists)
- [ ] `ui/auditLog.ts` — every invocation with args, result, duration

**Acceptance:** hand-write `find_near_duplicates` in the UI, register it, call it from the agent, see it in the audit log. Write a hostile tool (`while(true){}`, `fetch('https://evil')`, `indexedDB.open`) and confirm each is contained.

### Monday Aug 31 — evening (4h)

- [ ] `tools/meta.ts` — `propose_tool`, `dry_run_draft`, `list_available_tools`
- [ ] `store/proposals.ts`
- [ ] `ui/drawer.ts` — the review drawer in the §2.4 order: capabilities → dry-run diff → editable description → collapsed source
- [ ] Approve path: `descriptionAccepted = true` → persist → `registry.register()` → drawer closes → surface panel ticks up

**Acceptance:** ask the agent to propose a tool. It arrives in the drawer. You approve. It's callable in the same session without reload.

### Tuesday Sep 1 — evening (4h)

- [ ] `surface/entropy.ts` — overlap detection, "Extend existing tool" path, retirement chips
- [ ] Injection scanner + amber flag chips
- [ ] Toolpack export/import (JSON of `ToolDef[]`, import re-runs the full approval flow per tool — never bulk-trust an imported file)
- [ ] Error message polish across every failure path
- [ ] Empty states, loading states, mobile-ish responsive check

**FEATURE FREEZE at end of Tuesday.** Anything not working Tuesday night is cut.

### Wednesday Sep 2 — full day (8h)

Morning:
- [ ] Rehearse the demo 5 times against the live URL. Find the flaky bits. Fix only those.
- [ ] **Run the variance measurement** (§8) — you need the number for the write-up
- [ ] Record video, 4+ takes, pick the best

Afternoon:
- [ ] Edit video to under 3:00, upload to YouTube, **set to Public** (not Unlisted — rules say public)
- [ ] README (§7)
- [ ] File the spec issues (§9)
- [ ] Devpost submission text (§7.3)
- [ ] **Submit**

### Thursday Sep 3 — buffer (morning only)

Fix breakage, re-verify the live URL from a clean browser profile. Do not add features. Deadline is 1:00 pm PT.

---

## 6. Deployment configuration

### Vercel — `vercel.json`

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Origin-Agent-Cluster", "value": "?1" },
        { "key": "Permissions-Policy", "value": "tools=(self)" },
        { "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src https://anvil-sandbox.vercel.app; connect-src 'self'; base-uri 'none'; object-src 'none'" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "no-referrer" }
      ]
    }
  ]
}
```

### Netlify — `public/_headers`

```
/*
  Origin-Agent-Cluster: ?1
  Permissions-Policy: tools=(self)
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

### Sandbox origin — `_headers` / `vercel.json`

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'; frame-ancestors https://anvil.vercel.app
  X-Content-Type-Options: nosniff
```

Do **not** set `X-Frame-Options: DENY` on the sandbox origin — it must be framable by your app.

### Verification checklist after every deploy

1. `curl -I https://your-url | grep -i origin-agent` → `?1`
2. Console: `document.modelContext` → object, not `undefined`
3. Console: `await document.modelContext.getTools()` → 8 entries
4. Console: no CSP violations
5. Sandbox iframe present, `contentWindow` reachable, `ready` message received

---

## 7. Submission package

### 7.1 Repo requirements (from the rules)

- [ ] Public on GitHub
- [ ] **`LICENSE` (MIT) at root**, so the About section shows a detected license
- [ ] All source, assets, and setup instructions
- [ ] README contains a visible `document.modelContext.registerTool({...})` snippet — the rules literally show this pattern, put a real one near the top

### 7.2 README structure

1. One-line pitch + live URL + demo video link
2. The problem (procedural drift), 3 sentences
3. 30-second GIF of the propose → approve → call loop
4. **A real `registerTool` snippet**
5. How to run locally (`pnpm i && pnpm dev`) + how to enable WebMCP in Chrome
6. Architecture diagram (ASCII is fine)
7. **Security model** — the §3.8 table, plus the honest note about what the opaque-origin iframe does and does not guarantee
8. What's not done yet / known limitations
9. Links to the spec issues you filed

### 7.3 Devpost text — draft

**Why this use case fits WebMCP**

WebMCP tools run in the page, in the user's session, alongside the interface the human is looking at. That's the only substrate where noticing "I keep asking for this" and having a permanent capability for it can be one click apart. An MCP server is deterministic but requires a deploy and an auth flow, so the capability is never captured in the moment you needed it. Custom instructions capture it instantly but store it as prose, which gets re-interpreted every session — which is the problem, not the fix. Anvil sits exactly where WebMCP does: same page, same session, same live state, no install step.

**How it creates a better experience**

The agent stops re-deriving your idiosyncratic procedures. Ask it to dedupe your reading queue and it fumbles through pagination and eyeballing. Ask it to make that a tool, approve the behavior, and every future call is one deterministic invocation with identical results. Approval is behavioral rather than textual — you see the capabilities it requests and a dry run against your real data, not a wall of JavaScript. Your agent's abilities compound instead of resetting.

**What people and agents can do together that was hard before**

Extend the tool surface of a web app at runtime, collaboratively, with the human holding the registration key. Every WebMCP app shipped so far exposes a fixed list of tools chosen by the site's developer. In Anvil the agent authors the code, the human authors the prose and grants the capabilities, and a tool that didn't exist sixty seconds ago becomes callable without a reload. The app also manages the consequences: it detects when a proposal overlaps an existing tool and offers to extend it rather than fragmenting the surface, and it shows you what your tool surface costs your agent in context.

**How WebMCP is implemented**

All tools register on the top-level document via `document.modelContext.registerTool()`, with feature detection across the deprecated `navigator.modelContext` and a local shim so the app is fully usable in browsers without WebMCP. Since the current spec has no `unregisterTool()`, every tool holds an `AbortController` and unregistration aborts its signal; all lifecycle operations run through a serialized queue because the spec documents a race between unregistration and re-registration. The UI subscribes to `toolchange` and mirrors exactly what the agent currently sees. Custom tools register with `untrustedContentHint: true` and a `readOnlyHint` derived from their granted capabilities. User code executes in a cross-origin `sandbox="allow-scripts"` iframe at an opaque origin, with no ambient credentials and a capability-gated postMessage RPC back to the host; a watchdog destroys and recreates the frame on timeout. `propose_tool` deliberately cannot register anything — there is no code path from an agent call to a live tool.

### 7.4 Video — shot list, 2:50 target

| Time | Shot | Narration beat |
|---|---|---|
| 0:00–0:12 | ChatGPT browser, Anvil open, Site tools panel expanded showing 8 tools | "This is a reading queue. It exposes eight WebMCP tools." |
| 0:12–0:40 | Ask: "mark everything from arxiv as reading" — works cleanly | "The agent uses them normally." |
| 0:40–1:05 | Ask: "find the near-duplicates in my queue" — agent pages, reasons, is slow, misses one | "Here's something it has to re-derive every time." |
| 1:05–1:20 | "Make that a tool." Agent calls `propose_tool`. Drawer slides open. | "It writes the code. I don't." |
| 1:20–1:50 | Pan the drawer: capability chips (read-only, no network), dry-run diff on real items, the editable description with the agent-authored flag | "I'm approving what it can touch and what it did — not a wall of JavaScript. And I own the wording, because the description is what steers the model later." |
| 1:50–2:00 | Click Approve. **Site tools panel ticks 8 → 9, no reload.** | (let it land silently) |
| 2:00–2:20 | Ask the agent to use it by name. Instant, exact. Audit log entry appears. | "One deterministic call. Same answer every time." |
| 2:20–2:40 | Propose a near-duplicate tool → drawer offers "Extend `find_near_duplicates`" instead. Context-cost meter visible. | "Tool surfaces decay as they grow. So it consolidates instead of accreting." |
| 2:40–2:50 | Live URL on screen | "An MCP server with no server. Live now." |

Record at 1920×1080. Use a clean browser profile. Script the prompts word-for-word and paste them — do not type live. Have a fallback take with a reload in case live registration is flaky on the day.

---

## 8. Measure the variance claim

"More reliable" is a slogan until it's a number, and this is the only quantitative evidence in your whole submission.

Protocol: run the dedupe task **10 times without the tool** and **10 times with it**, fresh chat each time, identical prompt. Record the returned pair set each time.

Report: exact-match rate across runs, mean pairs found, and wall-clock. Expected shape: something like 4/10 identical without, 10/10 identical with. Put the table in the README and one line of it in the Devpost text.

If the numbers are unflattering, report them anyway and say what they show. Judges have seen a thousand unfalsifiable claims; a real measurement stands out even when it's modest.

---

## 9. File spec issues while you build

The challenge says it wants people shaping the standard. Almost nobody will actually do this. File on `github.com/webmachinelearning/webmcp` as you hit them, and link the issues from your README and submission:

1. **No provenance field distinguishing developer-authored from user-authored tools.** An agent cannot tell that a tool's description was written in-page at runtime rather than shipped by the site. `untrustedContentHint` covers output, not metadata origin.
2. **`registerTool`'s abort-to-unregister pattern produces unhandled rejections** in the common case. Ask whether the promise should resolve rather than reject on signal-triggered unregistration.
3. **The documented unregister/re-register race** (spec §3.1) has no application-level primitive for atomic replacement. Propose a `replaceTool` or a schema-version guard.

Write them as genuine questions from implementation experience, not as resume padding. One paragraph each with a code sample.

---

## 10. Risk register and cut lines

| Risk | Probability | Mitigation / cut line |
|---|---|---|
| Live registration needs a reload | Medium | Discovered Friday night. Approval triggers a 300ms soft reload; demo narration changes; product survives |
| Cross-origin sandbox eats a day | Medium | Fall back to same-origin Web Worker with globals deleted, and say so honestly in the README |
| Agent won't call `propose_tool` reliably | Medium | Iterate the description; add "Make this a tool" as a UI button that seeds the prompt |
| Judges read it as infrastructure, not experience | **High** | The demo must show a real personal task, never hello-world. This is why §2.2 matters |
| Time collapse from the AWS Strands deadline (Sep 15) | High | Accept it. This build eats a week; Strands has 12 days after |
| ChatGPT model/rollout variance on judging day | Medium | The shim means the app works in any browser. Say so in the README's first paragraph |

**Cut order if behind:** toolpack import/export → retirement chips → injection scanner UI (keep the `untrustedContentHint` annotation) → `dry_run_draft` → overlap detection.

**Never cut:** propose → approve → register. That loop *is* the submission.

---

## 11. Spec gotchas — quick reference

- `document.modelContext` is the current getter; `navigator.modelContext` was deprecated in Chromium 150. Feature-detect both.
- **HTTPS required** (SecureContext). `file://` is a special-cased exception.
- **Origin-isolated documents only.** `Origin-Agent-Cluster: ?0` disables WebMCP entirely.
- Permissions Policy feature is `tools`, default allowlist `'self'`.
- **ChatGPT's browser does not discover tools in iframes** (same-origin or cross-origin) and does not support the declarative HTML-attribute API. Register on the top-level document, imperatively.
- Requires GPT-5.6 Sol or Terra. Luna has WebMCP disabled. Unavailable in Enterprise and Edu workspaces.
- Tool names: 1–128 chars, ASCII alphanumeric plus `_`, `-`, `.` only.
- `registerTool` rejects with `InvalidStateError` on a duplicate name or an empty name/description.
- There is **no `unregisterTool()`** in the current IDL. Use `registerTool(tool, { signal })` and abort.
- `toolchange` fires on the `ModelContext` object, from a parallel queue — ordering relative to your other tasks is not guaranteed. Never depend on it for correctness; race it against a timer.
- `execute` receives `(inputObject, { signal })`. Honor the signal.
- Return values are JSON-serialized. Anything non-serializable fails the call silently from the agent's perspective.
- `annotations: { readOnlyHint, untrustedContentHint }` — both surface in ChatGPT's site-tools panel, which shows a read/write split.
- Chrome flag for local testing: `chrome://flags/#enable-webmcp-testing`. Origin trial available from Chrome 149.
- The **Model Context Tool Inspector** extension lets you list and manually invoke tools — use it for iteration instead of burning agent turns.

---

## 12. First commit checklist

```bash
mkdir anvil && cd anvil
pnpm create vite . --template vanilla-ts
pnpm add idb
curl -o LICENSE https://raw.githubusercontent.com/licenses/license-templates/master/templates/mit.txt  # edit name/year
git init && git add -A && git commit -m "skeleton"
# create vercel.json with headers from §6
vercel --prod
# then: build the §1 experiment and nothing else
```

Now go run the go/no-go test.
