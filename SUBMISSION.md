# Devpost submission — Anvil

Paste-ready text for the four required prompts, plus the video plan and the pre-submit checklist.

- **Live URL:** _(fill in after deploy)_
- **Repo:** https://github.com/11HimanshuSharma/anvil
- **Video:** _(fill in; must be public YouTube, under 3:00, with audio)_

---

## Elevator line

Anvil is a workspace where the tools your agent can call are written at runtime, by your agent, and approved by you — so the fiddly procedure you explained once becomes a permanent, deterministic capability instead of something re-derived from prose every session.

---

## 1. Why this use case is a strong fit for WebMCP

The problem Anvil solves is **procedural drift**. You explain your idiosyncratic way of doing something — how *you* triage a queue, what counts as stale, which fields get normalised. The agent does it well. Next session it does it slightly differently, because prose is re-interpreted every time it is read. Memory does not fix this; prose *is* the problem. A tool is the opposite of prose: frozen behaviour, same input, same output, indefinitely.

Turning a one-off success into a permanent tool has always been possible in principle and impractical in fact: an MCP server means a repo, a deploy and an auth flow, so the capability is never captured in the moment you noticed you needed it. Custom instructions capture it instantly but store it as prose — which is the problem, not the fix.

WebMCP is the only substrate where noticing *"I keep asking for this"* and having a permanent capability for it are one click apart. The tools run in the page, in the user's session, against live local state, alongside the interface the human is already looking at. That last part is what makes approval possible at all: the human can see a dry run against their real data before granting anything.

This is also the honest test of fit — **Anvil could not be an MCP server.** A server cannot register a new tool into a running session, cannot show you a dry run in the UI you are already using, and cannot let you edit the description that will steer the model before it takes effect.

## 2. How it creates a better user experience

Your agent's abilities compound instead of resetting.

Ask it to triage your reading queue and it fumbles: pages through items, re-derives your rules from your prose, and gets a slightly different answer each time. Ask it to *make that a tool*, approve the behaviour once, and every future call is one deterministic invocation. In our end-to-end test the tool changes 11 items on the first run and 0 on the second — same input, same output, which is exactly the property prose cannot give you.

The approval step is where most of the design went. Anvil never shows you forty lines of JavaScript and asks "approve?" — that is security theatre, because the audience who cannot stand up an MCP server cannot audit JavaScript either. Instead the review drawer shows, in order:

1. **What it can touch** — capability chips: *reads your items*, *writes your items*, *reaches the network: `api.example.com`*, or *pure computation — touches nothing*.
2. **What it actually did** — the draft is executed against your real items in a dry-run mode where writes are computed but never applied, and the result is rendered as a before/after diff: *`url: www.anthropic.com/…?utm_source=tldr → www.anthropic.com/…`*.
3. **The description you're committing to** — editable, pre-filled with the agent's draft and flagged as agent-authored, with its cost in tokens.
4. **Source** — collapsed, for the few who want it.

And because a growing tool surface makes an agent *worse* at choosing, Anvil shows what your tools cost your agent in context, flags a proposal that overlaps an existing tool and offers to extend it instead, and marks tools unused for a fortnight as retirement candidates.

## 3. What people and agents can do together that was hard before

**Extend the tool surface of a running web app, collaboratively, with the human holding the registration key.**

Every WebMCP app shipped so far exposes a fixed list of tools chosen by the site's developer. The question they answer is "what can a site let an agent do?" Anvil makes that list open-ended and authored by the user: the agent writes the code, the human writes the prose and grants the capabilities, and a tool that did not exist sixty seconds ago becomes callable — no reload, no deploy, no OAuth.

The division of labour is the design, and it is a security property rather than a convenience:

> **The agent supplies the code. The human supplies the prose.**

Code is sandboxed and capability-scoped, so it cannot steer the model. Descriptions *are* the steering mechanism — they load into the model's context in every future session — so a model-authored description is never registered until a human has read and accepted the wording. `descriptionAccepted` gates registration, and exactly one line of code sets it: the Approve button.

This matters because Anvil takes the spec's tool-poisoning attack and makes it *persistent and user-blessed*. If an agent reads a poisoned page and then proposes a tool, injected instructions could otherwise live forever in a description. The structural answer is human acceptance; a scanner additionally flags injection-shaped text and schemas asking for credentials — flagging, never blocking, because a phrase blocklist is trivially evaded and pretending otherwise would be theatre.

## 4. How WebMCP is implemented

All tools register on the top-level document via `document.modelContext.registerTool()`, with feature detection across the deprecated `navigator.modelContext` and a local shim, so the app is fully usable in browsers without WebMCP.

Three spec facts shaped the lifecycle engine:

- **There is no `unregisterTool()`.** Every tool holds an `AbortController`; unregistration aborts its signal.
- **Aborting rejects the original `registerTool` promise**, so every registration attaches a `.catch()` at the call site — a test asserts zero unhandled rejections across a full register → unregister → re-register cycle. That promise also cannot both resolve on success *and* reject on abort: it stays pending, so awaiting it to completion hangs forever. The registry races it against a macrotask.
- **The spec documents an unregister/re-register race**, so all lifecycle operations run through one serialized queue and `toolchange` is raced against a timer rather than depended on for correctness.

The UI subscribes to `toolchange` and mirrors exactly what the agent currently sees. Custom tools register with `untrustedContentHint: true` and a `readOnlyHint` derived from the capabilities the *user granted* — never from anything the model claimed — so ChatGPT's own site-tools panel shows the correct read/write split.

User code executes in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, which gives it an **opaque origin**: no access to the workspace database, cookies or DOM, and no ambient credentials. Its only channel out is a `MessageChannel` port the harness keeps in a closure, so tool code cannot forge host calls; capabilities are re-checked parent-side on every call, keyed to the active execution. A watchdog destroys and rebuilds the executor on timeout.

Some embedded browsers refuse to run scripts in a sandboxed iframe at all. Rather than fail silently, Anvil detects this, explains what is lost, and offers a same-origin Web Worker fallback behind an explicit click — and a test proves the difference rather than asserting it: a deleted global can be recovered through the prototype chain in the worker (`RECOVERED AND USABLE`) but buys nothing in the opaque-origin frame (`not recoverable`).

`propose_tool` deliberately cannot register anything. `src/tools/meta.ts` does not import the registry, and returns `{ status: "pending_review", registered: false, callable: false }`. **There is no code path from an agent call to a live tool.**

---

## Video plan — 2:50 target

Record at 1920×1080 on a clean profile. Script the prompts word for word and paste them; do not type live.

| Time | Shot | Narration |
| --- | --- | --- |
| 0:00–0:12 | ChatGPT browser, Anvil open, site-tools panel expanded showing 8 tools | "A reading queue. It exposes eight WebMCP tools." |
| 0:12–0:32 | "Mark everything from arxiv as reading" — works cleanly | "The agent uses them normally." |
| 0:32–1:00 | **Ask it to triage the queue by my rules. Then ask again in a fresh chat. Show the two different answers side by side.** | "Same rules, same queue, two different answers. This is what prose does." |
| 1:00–1:15 | "Make that a tool." Agent calls `propose_tool`. Drawer slides open. | "It writes the code. I don't." |
| 1:15–1:45 | Pan the drawer: capability chips, the before/after diff on real items, the editable description with its agent-authored flag | "I'm approving what it can touch and what it did — not a wall of JavaScript. And I own the wording, because the description is what steers the model later." |
| 1:45–1:55 | Click Approve. **Site-tools panel ticks 8 → 9. No reload.** | (let it land silently) |
| 1:55–2:20 | Ask the agent to use it by name. Twice. Identical both times. Audit log fills in. | "One deterministic call. Same answer every time." |
| 2:20–2:40 | Propose a near-duplicate → drawer offers "Extend `triage_queue`". Context-cost meter visible. | "Tool surfaces decay as they grow. So it consolidates instead of accreting." |
| 2:40–2:50 | Live URL on screen | "An MCP server with no server. Live now." |

Record a fallback take with a reload after approval, in case live registration is flaky on the day.

---

## Pre-submit checklist

- [ ] Deployed to HTTPS; `curl -sI <url> | grep -i origin-agent` returns `?1`
- [ ] Opened in ChatGPT's in-app browser on GPT-5.6 Sol or Terra; **live registration confirmed without a reload**
- [ ] Sandbox confirmed working in that browser (or the fallback banner confirmed to appear and work)
- [ ] Video under 3:00, uploaded, **set to Public** (not Unlisted)
- [ ] Repo public, MIT `LICENSE` detected in GitHub's About sidebar
- [ ] README shows a real `document.modelContext.registerTool({...})` snippet near the top
- [ ] Live URL and video link filled in above, in the README, and on Devpost
- [ ] Variance measurement run and recorded (see `scripts/measure-variance.mjs`)
