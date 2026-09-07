# Restore review readiness and Second Self branding

User-approved scope: recover existing detail output without another model turn; distinguish generation from review readiness; retain memory-generation state across navigation; refresh memory and approval read models; package the approved icon.

## Global constraints

- Never auto-approve content or preferences. Existing approved outline and source evidence remain authoritative.
- No paid API, real generation rerun, direct database patch, or customer content committed to Git.
- Preserve raw recovered output. Normalize only known representations; reject unsupported data with actionable paths. Preserve conceptual diagram instructions in the image brief rather than inventing editable geometry.
- Recover through Worker validation and Rust atomic workspace/SQLite commit with the current revision guard.
- Existing app process is not restarted automatically. Build a new app and explain when a restart is needed.

### Task 1: Detail contract and recovery

Add tests for string body, columns/numeric table cells, conceptual diagrams, missing citation titles, unknown fields, approved outline mismatches, and strict Worker acceptance. Add a normalization boundary and full nested schema instructions to detail generation. Existing valid canonical details must remain unchanged. Preserve legacy table notes, source annotations, and conceptual shape specifications explicitly in the image brief. Do not accept arbitrary shape definitions silently. Run real parser/runtime integration tests, then save original task results privately and recover one complete result through the production harness with revision checks. Record any recovery limitations.

### Task 2: Memory lifecycle and human-readable checkpoint

Extend the existing application-owned generation registry to include memory proposals without losing pipeline state. Same-project duplicate clicks must share work; leaving and re-entering must replay running, success or failure. Keep the lock until Rust persists the proposal. Ground the proposal in the actual approved project snapshot. Add tests proving navigation, dedupe, failed persistence and explicit retry. Explain in the inspector that detail_review alone does not mean details exist. Work only in project-generation*, native-workspace*, relevant memory blocks in desktop-adapter.ts and dedicated tests.

### Task 3: Fresh approval and memory collections

Add a collection refresh seam that preserves live connection and task state. Refresh on entering approval/memory routes and after relevant updates. Derive PPT pending-review entries from real draft pipelines, not historical approved proof rows. Use a project-specific “前往审核” link to the existing guarded review UI instead of bypassing approval logic. Show saved proposed memories without re-generation. Add regression tests for empty/not-ready details, ready details, correct navigation, preserved account state, and route re-entry after a proposal finishes. Own App.tsx, workbench-store*, collection/UI tests and new collection helper; coordinate only additive adapter interface changes.

### Task 4: Approved icon packaging

Copy the approved generated PNG into project assets, generate Tauri/macOS icon sizes mechanically, explicitly configure bundle icons. Do not redesign or use a paid API. Verify dimensions/alpha and final bundle Info.plist/resource paths. Own icons and tauri.conf.json only; no native app restart.

### Task 5: Integration and delivery

Run targeted and complete tests, typecheck, lint and diff check. Run desktop/mobile browser checks for navigation and collection refresh with real app components and simulated external tasks; clearly label this boundary. Build the release .app only after tests. Inspect icon resources. Independently review all changes. Commit and push the approved source after checks; report what was actually recovered and what still needs user review.
