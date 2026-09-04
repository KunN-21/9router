# Batch1 upstream integration — design (approved)

Date: 2026-09-04
Branch: feat/batch1-upstream-merge (base 7723b796, fork master .3)
Upstream base: origin/master 4eda76e2 (v0.5.65)
Scope: 14 PR audit → 13 integration gates. #3520 excluded when #3779 lands.

## Goal

Merge giá trị upstream vào fork master .3, không phá routing/session/reasoning local, không conflict ngữ nghĩa, mỗi PR một commit revert được.

## Order (rủi ro tăng dần)

1. Sạch: #3772 → #3657 → #3540 → #3733 → #3523 → #3522 → #3650 → #3544.
2. Khó: #3779 (thay #3520) → #3560 harden → #3525 full-range → #3771 full-range → #3538 reconcile.

Lý do order:
- #3772 trước #3657: cùng `claude-to-openai.js`.
- #3650 trước #3544: cùng `usageRepo.js`.
- #3771 trước #3538: cùng `chatCore.js`; #3538 giữ `sourceTransport` precedence local.
- #3560 + #3771 cùng `combo.js`; #3560 trước để #3771 resolve trên nền đã có failover.

## Rulings

- #3779 thay #3520. Không lấy cả hai (trùng terminal guard). #3779 cần sửa mất usage cuối + tách helper trùng `toolArgs.js`.
- #3538 không lấy nguyên văn. Giữ `sourceTransport || modelTargetFormat` fallback local; chỉ lấy helper `upstreamRoute.js` + test alignment sau rebase.
- #3560 chỉ lấy sau rút timeout peek 200s + truyền abort signal. Không giữ peek dài treo stream.
- #3525 lấy đủ 2 commits (`d755e9006` + `e307efdf8`). Merge thủ công `codex-settings` route.
- #3771 lấy đủ 3 commits (`09502abcd`, `8d587866a`, `d747b3c8a`). Merge thủ công import/status `src/sse/handlers/chat.js`; kiểm tra tương tác #3770.
- #3772 lấy đủ 2 commits. #3779 lấy đủ 3 commits.

## Gates mỗi PR

1. GitNexus `impact` upstream symbol chính trước edit.
2. CodeGraph `explore` symbol + call path trước edit.
3. Cherry-pick đủ dải (`git cherry-pick -n <base>..<head>`), không `-X theirs` mù.
4. `node --check` file đổi + `git diff --check`.
5. Focused vitest đúng file PR liệt kê, không `-u`, không install.
6. Baselines: `verify-providers.mjs`, `verify-alias.mjs`, `verify-oauth-urls.mjs`.
7. `detect_changes` so với `origin/master`; dừng khi vượt file PR công bố.

## Dừng/rollback

- Dừng gate khi: conflict ngữ nghĩa, test đỏ mới, `detect_changes` lan file ngoài PR, baseline lệch byte.
- Rollback: `git reset --hard` về commit gate trước (ghi trong ledger), giữ `fork/master 7723b796` nguyên. Không push/merge master.

## Loại trừ

- Không động: `CLAUDE.md`, `AGENTS.md`, `checkpoint-*.md`, `data-dev/`, `probe-dup-endpoints.test.js`, `tree3.json`, `.tgz`.
- Không đọc: `.env.local`, DB, key/token, full headers, prompt/tool args, account identity.
- Không: live provider, server 20128, `git add -A`, `vitest -u`, global install, install artifact, push/merge/close PR.
