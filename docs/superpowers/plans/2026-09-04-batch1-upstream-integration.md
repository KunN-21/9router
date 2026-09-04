# Batch1 Upstream Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tích hợp an toàn 13 gate từ 14 PR đã audit vào nhánh local dựa trên fork master `7723b796`, giữ hành vi `.3` và loại #3520 khi #3779 được dùng.

**Architecture:** Mỗi PR là một commit độc lập/revert được. Các PR sạch được cherry-pick đủ range; PR khó được áp patch rồi sửa tối thiểu theo ruling. Trước mọi edit chạy GitNexus impact và CodeGraph; sau mỗi gate chạy test, baselines, detect_changes.

**Tech Stack:** JavaScript ESM, Next.js, Vitest, Git, GitNexus, CodeGraph.

**Spec:** `docs/superpowers/specs/2026-09-04-batch1-upstream-integration-design.md`

## Global Constraints

- Base bất biến: `7723b79620a0ee0e7b1ad2de9d2d972dae4290cc`; làm trên `feat/batch1-upstream-merge`.
- Không push, merge `master`, close PR, publish, install artifact.
- Không đọc `.env.local`, DB, key/token, full headers, prompt/tool args, account identity; không live provider.
- Không restart/kill/chạm server `20128`; không npm/global install; không `vitest -u`.
- Không edit/stage/commit protected: `CLAUDE.md`, `AGENTS.md`, `checkpoint-*.md`, `data-dev/`, `tests/unit/probe-dup-endpoints.test.js`, `tree3.json`, `tmp-x/`; không `git add -A`.
- Trước sửa symbol: GitNexus impact + CodeGraph source/call path. HIGH/CRITICAL ghi ledger và chỉ tiếp tục vì design đã duyệt đúng rủi ro đó.
- Mỗi task commit explicit paths. Nếu gate fail: abort/reset về SHA trước task, ghi nguyên nhân, không tiếp tục task phụ thuộc.
- Runner: dùng `tests/node_modules/vitest/vitest.mjs` nếu có; nếu thiếu, mượn runner đã tồn tại, không install.
- Sau mỗi task: `node --check` các JS production đổi, `git diff --check`, focused Vitest, 3 baselines, GitNexus detect_changes.

---

### Task 1: PR #3772 — Muse tool translation

**Files:**
- Modify: `open-sse/translator/request/claude-to-openai.js`
- Modify: `open-sse/translator/response/openai-responses.js`
- Modify tests: `tests/translator/bugs-claudeCode-context.test.js`, `tests/translator/bugs-openai-bridge.test.js`
- Create test: `tests/unit/openai-responses-parallel-tools.test.js`

**Interfaces:**
- Consumes: existing Claude/OpenAI Responses translation pipeline.
- Produces: tool index assigned at add-time; binary `tool_result` placeholder, no raw base64 dump.

- [ ] Impact `claudeToOpenAIRequest`/Responses response translator; CodeGraph both files and callers.
- [ ] Apply full two-commit range `0412ed778^..351a54dac` without committing.
- [ ] Verify PR diff remains exact semantic intent; resolve only local overlaps.
- [ ] Run `openai-responses-parallel-tools`, `bugs-claudeCode-context`, `bugs-openai-bridge`; run standard gates.
- [ ] Commit explicit five paths: `fix(translator): integrate Muse tool-call fixes`.

### Task 2: PR #3657 — max completion token key

**Files:**
- Modify: `open-sse/translator/formats/maxTokens.js`
- Modify: `open-sse/translator/request/{antigravity,claude,gemini}-to-openai.js`
- Create: `tests/unit/to-openai-max-completion-tokens.test.js`

**Interfaces:**
- Consumes: model family helpers and OpenAI request builders.
- Produces: `max_completion_tokens` for GPT-5/o-series; legacy models retain `max_tokens`.

- [ ] Impact max-token helper + three builders; CodeGraph call path.
- [ ] Apply `afd435f68` without commit; reconcile Task 1 overlap in `claude-to-openai.js`.
- [ ] Run new test plus request normalization neighbors; standard gates.
- [ ] Commit explicit five paths: `fix(translator): emit max completion tokens for reasoning models`.

### Task 3: PR #3540 — Grok CLI reasoning effort

**Files:**
- Modify: `open-sse/config/grokCli.js`
- Create: `tests/unit/grok-cli-executor.test.js`

**Interfaces:**
- Produces: Grok 4.6 forwards nested `reasoning.effort` using existing request shape.

- [ ] Impact Grok config transform; CodeGraph caller/executor path.
- [ ] Apply `9805bed86` without commit.
- [ ] Run `grok-cli-executor`; standard gates.
- [ ] Commit explicit two paths: `fix(grok-cli): forward Grok 4.6 reasoning effort`.

### Task 4: PR #3733 — Responses prompt cache key

**Files:**
- Modify: `open-sse/providers/REGISTRY_TEMPLATE.js`
- Modify six registries: `azure.js`, `codex.js`, `github.js`, `grok-cli.js`, `openai.js`
- Modify: `open-sse/translator/concerns/paramSupport.js`, `formats/responsesApi.js`, `translator/index.js`, `request/openai-responses.js`
- Modify/create tests named in PR diff.

**Interfaces:**
- Produces: provider-gated preservation of `prompt_cache_key` across Responses↔Chat.

- [ ] Impact `filterParams`, Responses builders, registration; CodeGraph flow.
- [ ] Apply `86fcbdb20` without commit; do not hand-regenerate unrelated registry index.
- [ ] Run three prompt-cache/Responses tests; baselines mandatory.
- [ ] Commit explicit 13 paths: `fix(translator): preserve Responses prompt cache key`.

### Task 5: PR #3523 — atomic sql.js persistence

**Files:**
- Modify: `src/lib/db/adapters/sqljsAdapter.js`
- Create: `tests/unit/sqljs-atomic-persist.test.js`

**Interfaces:**
- Produces: temp-file write + atomic publish; existing adapter API unchanged.

- [ ] Impact adapter persist/close symbols; CodeGraph driver callers.
- [ ] Apply `9765faf55` without commit; do not access runtime DB/WAL/SHM.
- [ ] Run atomic test and DB adapter unit tests; standard gates.
- [ ] Commit explicit two paths: `fix(db): persist sql.js database atomically`.

### Task 6: PR #3522 — tunnel CSPRNG short ID

**Files:**
- Modify: `src/lib/tunnel/shared/state.js`
- Create: `tests/unit/tunnel-shortid-csprng.test.js`

**Interfaces:**
- Produces: same short-ID alphabet/shape, cryptographically secure sampling.

- [ ] Impact short-ID generator; CodeGraph consumers.
- [ ] Apply `8d132bb34` without commit.
- [ ] Run CSPRNG test and tunnel neighbors; standard gates.
- [ ] Commit explicit two paths: `fix(tunnel): generate public subdomains with CSPRNG`.

### Task 7: PR #3650 — usage API-key identity

**Files:**
- Modify: `src/lib/db/repos/usageRepo.js`
- Modify: `tests/unit/security-audit.test.js`
- Create: `tests/unit/usage-api-key-prefix-collision-3640.test.js`

**Interfaces:**
- Produces: bucket identity independent of masked prefix; raw key never persisted/exposed.

- [ ] Impact usage aggregation functions; CodeGraph callers and security path.
- [ ] Apply `58ae11bd3` without commit; inspect no real credentials.
- [ ] Run new collision test + security audit + usage repo neighbors; standard gates.
- [ ] Commit explicit three paths: `fix(usage): bucket records by API key identity`.

### Task 8: PR #3544 — usage same-millisecond rows

**Files:**
- Modify: `src/lib/db/repos/usageRepo.js`
- Create: `tests/unit/usage-row-dedupe.test.js`

**Interfaces:**
- Consumes: Task 7 identity logic.
- Produces: no row loss when timestamps collide; pagination/dedupe semantics stable.

- [ ] Impact changed usage-query symbols; CodeGraph consumers.
- [ ] Apply `36aa66a83` without commit; manually retain Task 7 identity fields.
- [ ] Run both Task 7/8 tests + usage neighbors; standard gates.
- [ ] Commit explicit two paths: `fix(usage): retain rows sharing a millisecond`.

### Task 9: PR #3779 — tool argument terminal dedup (replaces #3520)

**Files:**
- Create: `open-sse/translator/concerns/toolArgs.js`
- Modify: `open-sse/translator/response/kiro-to-claude.js`
- Modify: `open-sse/translator/response/openai-to-claude.js`
- Create: `tests/unit/openai-to-claude-tool-arg-dedup.test.js`

**Interfaces:**
- Produces: shared repair/dedup helpers; repeated finish chunks close tool input once; late terminal usage forwarded.
- Excludes: PR #3520 commit `fa9cf979d`.

- [ ] Impact both response translators; CodeGraph terminal-event paths.
- [ ] Apply full range `2292579c7^..0e0633935` without commit.
- [ ] Verify shared helper removes duplicate parse logic and terminal path forwards usage even after tool close. Add/adjust focused regression asserting late usage survives repeated finish.
- [ ] Run new dedup test + OpenAI→Claude/Kiro translator neighbors; standard gates.
- [ ] Commit explicit four paths: `fix(translator): deduplicate terminal tool arguments`.

### Task 10: PR #3560 — empty stream failover, hardened

**Files:**
- Modify: `open-sse/services/combo.js`
- Create: `tests/unit/combo-empty-stream-3463.test.js`

**Interfaces:**
- Produces: peek first meaningful chunk; empty-success triggers next combo; caller abort cancels peek; bounded timeout much shorter than PR's 200s.

- [ ] Impact `handleComboChat` (known CRITICAL); CodeGraph full combo/chat flow.
- [ ] Apply `e526cc5e9` without commit.
- [ ] Replace fixed 200-second peek with existing request/connect timeout semantics or minimal bounded helper, and thread existing abort signal. No new setting/dependency.
- [ ] Add tests: empty failover, non-empty replay, usage-only terminal handling, caller abort, bounded timeout cleanup.
- [ ] Run combo empty stream + account-selection/fallback suites; standard gates.
- [ ] Commit explicit two paths: `fix(combo): fail over bounded empty streams`.

### Task 11: PR #3525 — no-clobber CLI settings, full range

**Files:**
- Modify: `src/app/api/cli-tools/codex-settings/route.js`
- Modify: `src/app/api/cli-tools/copilot-settings/route.js`
- Create: `src/lib/cliTools/readExistingConfig.js`
- Create: `tests/unit/cli-tools-refuse-to-clobber.test.js`

**Interfaces:**
- Produces: shared safe config reader; unreadable existing file cannot be overwritten; other provider sections retained.

- [ ] Run API impact on both route handlers before edit; impact shared helper; CodeGraph route/data paths.
- [ ] Apply full range `d755e9006^..e307efdf8` without commit.
- [ ] Resolve Codex route against local subscription/settings changes; retain all local fields and response contracts.
- [ ] Run no-clobber test and Codex/Copilot settings tests; standard gates.
- [ ] Commit explicit four paths: `fix(cli-tools): refuse to clobber unreadable settings`.

### Task 12: PR #3771 — error status classes, full range

**Files:**
- Create/modify: `open-sse/config/errorConfig.js`
- Modify: `open-sse/handlers/chatCore.js`, `services/accountFallback.js`, `services/combo.js`, `utils/error.js`
- Modify: `src/sse/handlers/chat.js`, `src/sse/services/auth.js`
- Create: `tests/unit/breaker-open-status.test.js`

**Interfaces:**
- Consumes: Task 10 combo failover and local Muse transport/session changes.
- Produces: wrong model permanent, request-local errors, preserved upstream 4xx/5xx, open breaker 503.

- [ ] Impact `handleChatCore`, `checkFallbackError`, `handleComboChat` (HIGH/CRITICAL) plus auth; CodeGraph whole error/fallback flow.
- [ ] Apply full range `09502abcd^..d747b3c8a` without commit.
- [ ] Resolve `chat.js` imports/status manually; preserve local OpenCode behavior and all local request/session metadata. Verify #3770 dependency semantics exist or port minimum needed provider-error classification.
- [ ] Run breaker test + fallback/combo/auth/error suites; standard gates.
- [ ] Commit explicit eight paths: `fix(errors): preserve upstream status classes`.

### Task 13: PR #3538 — transport/body alignment reconciliation

**Files:**
- Modify: `open-sse/handlers/chatCore.js`
- Create: `open-sse/handlers/chatCore/upstreamRoute.js`
- Create: `tests/unit/upstream-route-alignment.test.js`
- Re-run: `tests/unit/opencode-go-transport-routing.test.js`

**Interfaces:**
- Consumes: local `sourceTransport || modelTargetFormat` fallback and Task 12 error changes.
- Produces: endpoint chosen for translated body format without reversing local source-transport precedence.

- [ ] Impact `handleChatCore` (HIGH); CodeGraph transport resolution and executor path.
- [ ] Inspect `0003a03c8`; port helper/tests, not raw `chatCore.js` hunk.
- [ ] Preserve exact precedence: `sourceTransport` first; model target fallback only when source transport absent; selected endpoint must speak translated target format.
- [ ] Run upstream alignment + OpenCode Go routing + chatCore/transport neighbors; standard gates.
- [ ] Commit explicit three paths: `fix(transport): align upstream route with translated body`.

### Task 14: Whole-branch verification

**Files:** no production edits unless reviewer finds defect.

- [ ] Run `git diff 7723b796...HEAD --check` and audit changed-file inventory against union of approved PRs/spec.
- [ ] Run all focused tests from Tasks 1–13 together, then baseline verifier.
- [ ] Run GitNexus `detect_changes(scope:"compare", base_ref:"remotes/fork/master")`; inspect every affected process and ensure no protected/out-of-scope symbol.
- [ ] Dispatch independent whole-branch reviewer on most capable model. Fix only confirmed blockers, one fix round + scoped re-review.
- [ ] Confirm branch only; no push/master merge. Report commit list, tests, residual risks, exact next external action requiring user approval.
