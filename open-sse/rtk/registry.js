import { FILTERS } from "./constants.js";
import { gitDiff } from "./filters/gitDiff.js";
import { gitStatus } from "./filters/gitStatus.js";
import { gitLog } from "./filters/gitLog.js";
import { grep } from "./filters/grep.js";
import { find } from "./filters/find.js";
import { dedupLog } from "./filters/dedupLog.js";
import { ls } from "./filters/ls.js";
import { tree } from "./filters/tree.js";
import { smartTruncate } from "./filters/smartTruncate.js";
import { readNumbered } from "./filters/readNumbered.js";
import { searchList } from "./filters/searchList.js";
import { pytest } from "./filters/pytest.js";
import { goTest } from "./filters/goTest.js";
import { vitest } from "./filters/vitest.js";
import { tsc } from "./filters/tsc.js";
import { mypy } from "./filters/mypy.js";
import { prettier } from "./filters/prettier.js";
import { ruff, ruffCheck, ruffFormat } from "./filters/ruff.js";
import { cargoTest } from "./filters/cargoTest.js";

const REGISTRY = {
  [FILTERS.GIT_DIFF]: gitDiff,
  [FILTERS.GIT_STATUS]: gitStatus,
  [FILTERS.GIT_LOG]: gitLog,
  [FILTERS.GREP]: grep,
  [FILTERS.FIND]: find,
  [FILTERS.DEDUP_LOG]: dedupLog,
  [FILTERS.LS]: ls,
  [FILTERS.TREE]: tree,
  [FILTERS.SMART_TRUNCATE]: smartTruncate,
  [FILTERS.READ_NUMBERED]: readNumbered,
  [FILTERS.SEARCH_LIST]: searchList,
  [FILTERS.PYTEST]: pytest,
  [FILTERS.GO_TEST]: goTest,
  [FILTERS.VITEST]: vitest,
  [FILTERS.TSC]: tsc,
  [FILTERS.MYPY]: mypy,
  [FILTERS.PRETTIER]: prettier,
  [FILTERS.RUFF]: ruff,
  [FILTERS.RUFF_CHECK]: ruffCheck,
  [FILTERS.RUFF_FORMAT]: ruffFormat,
  [FILTERS.CARGO_TEST]: cargoTest
};

// Rust resolve_filter aliases (pipe_cmd.rs): grep|rg, find|fd
const ALIASES = {
  rg: grep,
  fd: find,
  "ruff-check": ruffCheck,
  "ruff-format": ruffFormat,
  "cargo-build": cargoTest,
  cargo: cargoTest
};

export function resolveFilter(name) {
  return REGISTRY[name] || ALIASES[name] || null;
}

export function allFilters() {
  return REGISTRY;
}
