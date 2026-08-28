# Anvil

**A workspace whose tools are written at runtime, by your agent, with your approval.**

Built for the OpenAI WebMCP Challenge. Every WebMCP demo so far answers *"what can a site let an agent do?"* with a fixed list the site's developer chose. Anvil makes that list open-ended and authored by the user: the moment your agent nails a fiddly task, you convert that one-off success into a permanently callable WebMCP tool — the agent writes the code, you approve the behaviour, and it registers live without a reload, a deploy, or an OAuth flow.

- **Live URL:** _(pending first deploy)_
- **Demo video:** _(pending)_
- **Status:** Step 1 of the build plan — the live-registration go/no-go probe — is complete and green locally.

## The problem

Agents suffer from *procedural drift*. You explain your idiosyncratic way of doing something, the agent does it well, and next session it does it slightly differently, because prose gets re-interpreted every time it is read. Memory does not fix this — prose *is* the problem. A tool is the opposite of prose: frozen behaviour, same input, same output, indefinitely.

## How WebMCP is used

Tools register on the top-level document, imperatively, with feature detection across the deprecated `navigator.modelContext` and a local shim so the app stays usable in browsers without WebMCP.

```js
document.modelContext.registerTool({
  name: "secret_handshake",
  title: "Secret handshake",
  description:
    "Returns a fixed handshake string that proves this tool was registered after " +
    "the page loaded. Call it and report the exact string it returns.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: async () => "banana-4417",
}, { signal: abortController.signal });
```

Three spec facts shape [`src/webmcp/registry.ts`](src/webmcp/registry.ts):

1. **There is no `unregisterTool()`.** You unregister by aborting the `AbortSignal` you passed to `registerTool`.
2. **Aborting rejects the original `registerTool` promise**, so every registration attaches a `.catch()` at the call site — otherwise the console fills with unhandled rejections. The probe asserts this: 0 unhandled rejections across a full register → unregister → re-register cycle.
3. **The spec documents an unregister/re-register race**, so every lifecycle operation runs through one serialized queue, and `toolchange` is raced against a 50 ms timer rather than depended on for correctness.

## Current contents

| Path | What it is |
| --- | --- |
| `src/webmcp/types.ts` | Typings for the WebMCP surface we depend on |
| `src/webmcp/context.ts` | Feature detection: `document.modelContext` → `navigator.modelContext` → shim |
| `src/webmcp/shim.ts` | Local `ModelContext` for browsers without WebMCP, mirroring the spec's observable behaviour |
| `src/webmcp/registry.ts` | Serialized register / unregister / replace with validation |
| `src/main.ts` | The go/no-go probe page (build plan §1) |

## Run locally

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. To test against a real implementation, enable `chrome://flags/#enable-webmcp-testing` in Chrome 149+, or open the deployed HTTPS URL in the ChatGPT desktop app's in-app browser (GPT-5.6 Sol or Terra; Luna has WebMCP disabled, and it is unavailable in Enterprise/Edu workspaces).

`npm run build` runs `tsc --noEmit` before `vite build`, so a type error fails the build.

## Deployment

Headers matter more than usual here: WebMCP requires a secure context and an origin-isolated document. `Origin-Agent-Cluster: ?0` disables it entirely.

- Vercel: [`vercel.json`](vercel.json)
- Netlify: [`netlify.toml`](netlify.toml) + [`public/_headers`](public/_headers)

Verify after every deploy:

```bash
curl -sI https://<your-url> | grep -i -E 'origin-agent|permissions-policy|content-security'
```

## License

MIT — see [LICENSE](LICENSE).
