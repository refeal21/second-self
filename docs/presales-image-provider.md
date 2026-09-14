# Presales v3 private Codex provider

Implemented against the captured **Codex CLI 0.153.4** App Server schema. Tests use synthetic accounts, configuration, files and executable child processes. No real account/config/model RPC, live generation, billing probe, credential read or login mutation was performed.

## Ownership and execution

The existing application-owned `QueueSupervisor` remains the single image/text FIFO, concurrency (1–4), pause, epoch and uncertainty authority. Its dedicated Worker runs `sidecar-cli.ts --presales-runtime`. Production `runPresalesRuntime` constructs `PrivateCodexProvider` with `PrivateAppServerTransport`; that transport forwards only over the private native channel.

`provider_process.rs` owns an actual separate `CodexAppServerProcess`. Its native command uses `app-server --listen stdio:// -c model_provider="openai"`, with the dedicated v3 asset root as working directory. Each Unix child owns its process group. Supervisor shutdown kills/waits for that child and its tool group; the existing WebView/legacy process state cannot address it. Private stdout drains complete frames before reporting exit. Legacy command construction and legacy image generation are unchanged.

The child shares the existing Codex account and credential location. Only this child removes these fixed environment overrides, without reading their values: `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_BASE_URL`, `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE`, `OPENAI_WORKLOAD_IDENTITY_CONTEXT`. This list is defensive, not an assertion of exhaustive installed-version environment precedence. Proxy and CA variables remain inherited. No `env_clear` on the Codex child, new `CODEX_HOME`, token copying, login/logout, forced-login change, credential-store change, API-key client or application fallback is introduced. The separate Worker keeps its existing cleared environment.

## Accepted stock route

Before readiness and again before every turn, the private adapter validates:

1. `account/read({refreshToken:false})`: `account.type === "chatgpt"` and `requiresOpenaiAuth === true`.
2. `config/read({includeLayers:false,cwd})`, with the same native asset cwd: the schema's `model_provider` is `openai` or null (the child explicitly pins openai). A missing field is malformed. Exposed `openai_base_url` / `chatgpt_base_url` must be absent or null. Non-ChatGPT forced-login configuration, a selected built-in-provider redefinition, or a custom selected provider is rejected. Unselected custom-provider definitions are not inspected.
3. `configRequirements/read({})`: a valid null/object requirement response, without an exposed `chatgptBaseUrl` override.
4. `model/list`: bounded pagination (100/page, at most 8 pages), exactly one default with a valid model string and declared text input. The exact returned model is pinned on subsequent thread and turn requests; there is no hardcoded model or fallback selection.

Full config/account responses stay inside the native/Worker channel. The adapter emits only minimal capability booleans and fixed reasons; private RPC errors are redacted. No endpoint-attestation field is invented. A stock route does not require a live generation probe to become protocol-capable. A custom endpoint is rejected even if it uses OpenAI authentication and advertises image generation.

The schema does not provide atomic “require this ChatGPT account for this turn” or immutable endpoint/auth attestation. Account validation and submission are separate operations. Any `account/updated` (including another ChatGPT update), child exit or restart invalidates the capability revision. Delayed reads cannot restore an older revision. In-flight jobs receive interruption requests when IDs are known and retain uncertainty until correlated terminal evidence. This operational policy prevents an application-level API-key/paid fallback; it does not claim exhaustive endpoint attestation against external concurrent credential/config changes or arbitrary proxies.

## Capabilities and UI contract

`presales_v3_queue` retains `dispatchAvailable` for common text/runtime readiness and adds:

```ts
capabilities: {
  generation: boolean;
  referenceEditing: boolean;
  reason?: string;
}
```

Generation additionally requires a well-formed `modelProvider/capabilities/read` response with `imageGeneration:true`. Reference editing additionally requires the selected model's `inputModalities` to include `image` and this adapter's actual `localImage` serialization. Account plan type alone grants neither capability. `referenceEditing:true` means the validated protocol/input contract is enabled; real reference influence remains live-unverified.

Unsupported image/reference jobs remain queued and ineligible in the **same** native FIFO query. Text jobs continue under the same slots and pause setting. No second scheduler, alternate queue or silent text-only image fallback is used. Status acknowledges promptly while bounded provider readiness runs in the background; unavailable native hosts recheck readiness on their existing actor loop.

The registered lazy preview command has only these top-level camelCase arguments:

```ts
presales_v3_read_image({ projectId, slideId, versionId, assetId, sha256 })
  // -> { mimeType: "image/png", base64: string }
```

It accepts no path, provider reply or renderer bytes. `provider_assets.rs` checks the loaded project's page/version ownership, existing import/publication evidence, artifact index, exact immutable image identity/hash/length, descriptor-checked path and existing PNG content/size validation before returning bytes. Missing-image history stays readable and must not request a preview. The same authority resolves parent PNGs for the provider. Page reference inputs additionally use the existing reference-asset authority. Text source/analysis locators are rechecked against the captured whole-pair target, receipt, asset index and immutable file evidence.

## Verified App Server contract

Each job creates its own ephemeral `thread/start` with exact native cwd, `modelProvider:"openai"`, the catalog default model, `allowProviderModelFallback:false`, `approvalPolicy:"never"`, `approvalsReviewer:"user"`, and `sandbox:"read-only"`. The fallback flag controls model replacement, not billing. Returned provider/model identities must match. The thread identity is persisted natively **before** `turn/start`; the turn identity is persisted before buffered completion can publish.

Image `turn/start.input` is the exact persisted frozen prompt followed by actual `localImage` entries: parent first when present, then selected references in their persisted order. Reference purposes already occur in the frozen native prompt. The provider never substitutes hashes or drops unsupported images. First-generation references without a parent are also supported. Speaker notes/provenance remain governed by the exact native frozen-content prompt; the adapter adds no slide-visible text.

Text turns submit Task 3d's exact saved complete-pair prompt. Source/analysis files remain in the checked native asset cwd under their captured relative locators. The final `agentMessage` text must be a unique bounded complete envelope (2 MiB); the runtime's existing outline/details pair parsers run before native publication. No legacy bare-output writer or automatic approval/promotion is involved.

Consumed events are `item/started`, `item/completed` and `turn/completed`, correlated by thread/turn identity. Image items use `type:"imageGeneration"`, `status`, `failure`, `result` and `id`; image result bytes must be bounded PNG base64 (32 MiB decoded bound) and are validated again in the native vault. `savedPath` is never a trusted result path. `agentMessage` final/null phase supplies text. A completed turn without an image, multiple images, malformed/failed image result, or `usageLimitExceeded` becomes an explicit correlated failure. `turn.status:"interrupted"` is cancellation proof. An interrupt RPC acknowledgement, generic error event, timeout, auth change or process loss is not terminal proof and never authorizes a resend.

Ephemeral threads have no proven durable recovery contract here. Restart keeps uncertain slots; save retry publishes already verified local results only. Explicit risk-acknowledged abandonment remains the existing way to relinquish an unresolved slot.

## Private messages and bounds

- Worker → native: `native/provider/start`, `native/provider/send`, `native/provider/inputs`, and existing `native/identity`. Every message carries the Worker process generation; input/identity callbacks also carry the full exact active work.
- Native → Worker: `presales/provider/line`, `presales/provider/lost`; existing status/start/interrupt controls remain correlated. Worker readiness changes use `presales/capabilities`.
- These methods are absent from Tauri command registration and legacy RPC handling. Native provider transport additionally allows only initialize/initialized, read account/config/requirements/models/capabilities, thread/start, turn/start and turn/interrupt methods.
- Native private Codex stdout frames: 64 MiB, assembled as complete valid UTF-8. Wrapped native→Worker frames: 72 MiB; Codex input: 9 MiB. Existing Worker output/callback/control bounds and native bounded channels remain in place. Private control RPCs time out after 15 seconds; turns retain the 10-minute uncertainty deadline.

## Sources and evidence limits

Local generated schema: `.superpowers/sdd/2026-09-11-presales-v3-workbench/protocol/v2/{Account,GetAccountResponse,ConfigReadParams,ConfigReadResponse,ConfigRequirementsReadResponse,ModelListResponse,Model,UserInput,ThreadStartParams,ThreadStartResponse,TurnStartParams,TurnStatus,ThreadItem}.ts` and root `ImageGenerationItem.ts`. The task's `provider-evidence.md` and `task-5-route-map.md` capture version/date and limitations.

Official pages were refreshed by the controller on 2026-09-14: [App Server](https://learn.chatgpt.com/docs/app-server), [image generation](https://learn.chatgpt.com/docs/image-generation), [authentication](https://learn.chatgpt.com/docs/auth). The route-map audit also opened [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), and [environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables). Installed schema compatibility takes precedence over newer web-only sandbox fields.

Synthetic tests prove executable ownership/isolation/shutdown, JSONL transport, route rejection/acceptance decisions, exact prompts, actual PNG reference paths, identity persistence ordering, native pair/image publication, preview ownership/tamper rejection, cancellation uncertainty and no resend after restart. They do **not** prove current real account access, model availability, actual endpoint/auth selection, generation success/quality, reference influence, usage/billing, or remote ephemeral recovery. Those remain live-unverified.
