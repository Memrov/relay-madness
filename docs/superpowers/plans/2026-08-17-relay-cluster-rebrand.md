# Relay Cluster Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the published product surface to Relay Cluster, narrow the implementation to Codex Cloud and Claude Code Cloud, and merge a verified release-ready tree without publishing the npm package.

**Architecture:** Preserve the existing thin `RelayCore` architecture and stable `relay` command/tool vocabulary. Remove Jules at every executable boundary, change only the public product/package/MCP/state identities, and keep GitHub as the durable blackboard and verification authority.

**Tech Stack:** TypeScript, Node.js, Commander, MCP TypeScript SDK, Zod, SQLite, Node test runner, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-17-relay-cluster-rebrand-design.md`

## Global Constraints

- Follow test-driven development: establish a focused failing assertion before each production change.
- Keep the executable `relay`, MCP tool names, `RELAY_*` variables, `relay/*` branch namespaces, and internal `RelayCore` names unchanged.
- Delete Jules production code and provider-specific tests; preserve provider-neutral behavior coverage by rewriting fixtures around Claude and Codex.
- Do not migrate or delete the unpublished `relay-madness` state directory.
- Do not publish the npm package in this change.
- Completion requires a pushed branch, passing macOS and Ubuntu CI, merged PR, renamed GitHub repository, clean merged `main`, and `origin/main` equality.

---

### Task 1: Narrow the provider contract to Codex and Claude

**Files:**

- Modify: `src/provider.ts`
- Modify: `src/relay-core.ts`
- Modify: `tests/relay-core.test.ts`
- Modify: `tests/state-store.test.ts`
- Delete: `src/providers/jules.ts`
- Delete: `tests/jules-provider.test.ts`

- [ ] **Step 1: Add failing provider-scope regressions**

Add focused tests proving the core reports only `claude` and `codex`, provider validation rejects `jules`, and newly written state cannot use a Jules provider. Rewrite existing three-provider fixtures to exercise the same concurrency, lineage, skill, and recovery behavior using multiple Claude/Codex accounts or sessions.

- [ ] **Step 2: Run the focused suites and capture RED**

Run: `npm test -- tests/relay-core.test.ts tests/state-store.test.ts`

Expected: FAIL because `ProviderName`, provider loops, and test fixtures still admit Jules.

- [ ] **Step 3: Remove Jules from the core contract**

Change `ProviderName` to exactly `'claude' | 'codex'`. Replace hard-coded three-provider loops with the two supported providers. Delete the Jules adapter and its provider-specific suite. Do not add an experimental flag, compatibility provider, or plugin placeholder.

- [ ] **Step 4: Run focused tests and type checking**

Run: `npm run check && npm test -- tests/relay-core.test.ts tests/state-store.test.ts`

Expected: PASS with no Jules type or runtime surface.

- [ ] **Step 5: Commit the provider narrowing**

Run: `git add src/provider.ts src/relay-core.ts tests/relay-core.test.ts tests/state-store.test.ts src/providers/jules.ts tests/jules-provider.test.ts && git commit -m "refactor: focus providers on Codex and Claude"`

---

### Task 2: Remove Jules from the CLI and application composition root

**Files:**

- Modify: `src/app.ts`
- Modify: `src/repl.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Add failing CLI and composition regressions**

Add tests proving:

- `relay --help`, `relay init --help`, provider command help, `doctor`, and `providers` expose no Jules option or label;
- `relay delegate jules ...` produces the typed invalid-provider error;
- the application provider registry is exactly Claude and Codex;
- the REPL welcome text says Relay Cluster and its provider switch rejects Jules.

- [ ] **Step 2: Run the CLI suite and capture RED**

Run: `npm test -- tests/cli.test.ts`

Expected: FAIL on the current Jules import, option, shortcut, provider list, error copy, or old welcome text.

- [ ] **Step 3: Implement the two-provider CLI**

Remove `JulesProvider`, `JULES_API_KEY`, `--jules-source`, the `jules` shortcut, Jules help copy, and Jules provider construction. Keep `relay`, `claude`, and `codex` command behavior stable. Change the CLI description and REPL identity to Relay Cluster without renaming internal APIs.

- [ ] **Step 4: Run the CLI suite and check**

Run: `npm run check && npm test -- tests/cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the application-surface change**

Run: `git add src/app.ts src/repl.ts tests/cli.test.ts && git commit -m "refactor: remove Jules command surfaces"`

---

### Task 3: Rename the MCP, package, and state identities

**Files:**

- Modify: `src/app.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `tests/package-smoke.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add failing identity regressions**

Add tests proving:

- the MCP implementation identity is `relay-cluster` and every provider schema rejects Jules;
- MCP status/provider examples contain only Claude and Codex;
- the default state path resolves under `relay-cluster/relay.db` when `XDG_STATE_HOME` is supplied;
- package metadata is named `relay-cluster` while its binary remains `relay`;
- the packed package contains no Jules module or fixture.

Expose a small pure state-path resolver from `src/app.ts` if required to test the path without opening the user's database.

- [ ] **Step 2: Run identity tests and capture RED**

Run: `npm test -- tests/mcp.test.ts tests/package-smoke.test.ts tests/cli.test.ts`

Expected: FAIL on `relay-madness`, the Jules MCP enum, or package metadata.

- [ ] **Step 3: Implement the public identity rename**

Set the package name, MCP implementation name, STDERR readiness copy, and default state subdirectory to `relay-cluster`. Update the lockfile mechanically with `npm install --package-lock-only --ignore-scripts`. Keep the binary and MCP tool names unchanged.

- [ ] **Step 4: Run focused tests and inspect the package**

Run: `npm run check && npm test -- tests/mcp.test.ts tests/package-smoke.test.ts tests/cli.test.ts && npm pack --dry-run`

Expected: PASS; package is `relay-cluster`, executable remains `relay`, and no Jules code ships.

- [ ] **Step 5: Commit the identity change**

Run: `git add src/app.ts src/mcp.ts tests/mcp.test.ts tests/package-smoke.test.ts tests/cli.test.ts package.json package-lock.json && git commit -m "chore: rename package to Relay Cluster"`

---

### Task 4: Rewrite the current product story and mark predecessor documents

**Files:**

- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `SECURITY.md`
- Modify: `NOTICE`
- Modify: `docs/superpowers/specs/2026-08-16-relay-madness-design.md`
- Modify: `docs/superpowers/plans/2026-08-16-relay-madness-full-build.md`
- Modify: `docs/superpowers/plans/2026-08-16-account-fleet-and-safe-landing.md`
- Modify: `docs/superpowers/plans/2026-08-17-portable-agent-skills.md`
- Modify: `docs/superpowers/specs/2026-08-17-portable-agent-skills-design.md`

- [ ] **Step 1: Rewrite the README around the approved story**

Start with the exact approved two-sentence description and thesis. Then cover, in order: isolated provider computers, the blackboard/control-plane theory, boundaries, minimal setup, human and MCP examples, caller-supplied usage/capacity, GitHub landing/merge safety, honest two-provider capabilities, installation, and development.

State plainly that Claude is read-only in Relay Cluster, Codex scripted follow-up is unavailable, credentials remain provider-owned, usage is user-reported, and the tool does not proxy subscription tokens or evade provider limits.

- [ ] **Step 2: Update current project metadata documents**

Change current names, repository URLs, provider descriptions, and security boundaries in CONTRIBUTING, SECURITY, and NOTICE. Remove Jules configuration and examples.

- [ ] **Step 3: Preserve history without presenting it as current**

Add a visible top banner to predecessor specs and plans explaining that they are historical implementation records and that the current product is Relay Cluster with only Codex and Claude. Do not rewrite historical steps as though they were the present architecture.

- [ ] **Step 4: Audit current documentation surfaces**

Run:

`rg -n -i "relay madness|relay-madness|jules|JULES_API_KEY" README.md CONTRIBUTING.md SECURITY.md NOTICE package.json src tests`

Expected: no matches in current product, production, package, or test surfaces. Historical documentation may retain matches only beneath an explicit historical banner.

- [ ] **Step 5: Commit the story and documentation**

Run: `git add README.md CONTRIBUTING.md SECURITY.md NOTICE docs/superpowers && git commit -m "docs: tell the Relay Cluster story"`

---

### Task 5: Verify, package-test, publish the branch, merge, and rename the repository

**Files:**

- Verify all changed files and GitHub repository metadata.

- [ ] **Step 1: Run the complete local verification gate**

Run: `npm run verify`

Expected: TypeScript checks, lint/format checks, and the full test suite pass.

- [ ] **Step 2: Run dependency and package release checks**

Run: `npm audit --omit=dev`

Run: `npm publish --dry-run --access public`

Create a temporary directory outside the repository, install the produced tarball normally, run its `relay --help`, and open the SQLite-backed provider surface with an isolated `XDG_STATE_HOME`. Remove only that exact temporary directory afterward.

Expected: no production vulnerability, dry run succeeds, clean install starts, and only Claude/Codex appear.

- [ ] **Step 3: Self-review the release diff**

Run: `git diff 7c02850...HEAD --check`

Run: `git status --short`

Run: `rg -n -i "relay madness|relay-madness|jules|JULES_API_KEY" README.md CONTRIBUTING.md SECURITY.md NOTICE package.json src tests`

Expected: clean committed tree; no accidental old current-product/provider surfaces.

- [ ] **Step 4: Push and open a ready pull request**

Push `agent/relay-cluster-rebrand`, create a non-draft PR titled `Rename project to Relay Cluster`, include test/package evidence, and request no provider-paid live run because this rename does not change an adapter protocol.

- [ ] **Step 5: Wait for both CI platforms and merge**

Use `gh pr checks --watch` and require macOS plus Ubuntu jobs to pass. Merge the PR only after the expected head SHA is unchanged and all required checks are green.

- [ ] **Step 6: Rename the GitHub repository after merge**

Confirm `Memrov/relay-cluster` is still unclaimed. Rename `Memrov/relay-madness` to `Memrov/relay-cluster`, then set the local `origin` URL explicitly to the new repository and verify it with `gh repo view Memrov/relay-cluster`.

- [ ] **Step 7: Verify the authoritative merged state**

Switch to `main`, fetch and fast-forward from the renamed origin, rerun `npm run verify`, and prove:

- `git status --short --branch` is clean;
- `git rev-parse HEAD` equals `git rev-parse origin/main`;
- the merged PR is closed as merged;
- macOS and Ubuntu checks succeeded on the merged commit;
- the repository URL is `https://github.com/Memrov/relay-cluster`.
