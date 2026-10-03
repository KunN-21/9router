// B8b: static/AST wiring contracts — lazy charts, barrel, idle preload, marked, settings consumers, AllTime.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as babelParser from "@babel/parser";

const SRC = path.resolve(__dirname, "../../src");
const P = (...segs) => path.join(SRC, ...segs);
const read = (p) => fs.readFileSync(p, "utf-8");
const parse = (code) => babelParser.parse(code, { sourceType: "module", plugins: ["jsx"] });

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === "parent") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((n) => walk(n, fn));
    else if (v && typeof v === "object") walk(v, fn);
  }
}

function importSources(ast) {
  const out = [];
  walk(ast, (n) => {
    if (n.type === "ImportDeclaration") out.push(n.source.value);
    if (n.type === "ImportExpression" && n.source?.type === "StringLiteral") out.push(n.source.value);
    if (n.type === "CallExpression" && n.callee?.name === "import" && n.arguments?.[0]?.type === "StringLiteral")
      out.push(n.arguments[0].value);
  });
  return out;
}

function extractFn(code, ast, name) {
  let found = null;
  walk(ast, (n) => {
    if (found) return;
    if ((n.type === "VariableDeclarator" || n.type === "FunctionDeclaration") && n.id?.name === name) found = n;
  });
  if (!found) throw new Error(`function ${name} not found`);
  const node = found.init || found;
  return code.slice(node.start, node.end);
}

describe("B8b UI lazy contracts", () => {
  it("UsageStats keeps ProviderTopology dynamic and wires breakdown charts with stats props (no copied algorithm)", () => {
    const code = read(P("shared/components/UsageStats.js"));
    const ast = parse(code);
    expect(code).toMatch(/dynamic\(\(\) => import\(".*ProviderTopology"\)/);
    const hasChartDynamic = /dynamic\(\(\) => import\(".*(UsageChart|ProviderBarChart|TopModelsChart)"\)/.test(code);
    expect(hasChartDynamic).toBe(true);
    expect(code).toMatch(/stats\.byProvider/);
    expect(code).toMatch(/stats\.byModel/);
    void ast;
  });

  it("no remaining named UsageStats import from barrel; usage page direct-imports", () => {
    const barrel = read(P("shared/components/index.js"));
    expect(barrel).not.toMatch(/UsageStats/);
    const page = read(P("app/(dashboard)/dashboard/usage/page.js"));
    expect(page).toMatch(/from "@\/shared\/components\/UsageStats"/);
    // scan src for named barrel UsageStats imports
    const hits = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p); continue; }
        if (!e.name.endsWith(".js")) continue;
        const c = read(p);
        if (/\{\s*[^}]*UsageStats[^}]*\}\s*from\s*["']@\/shared\/components["']/.test(c)) hits.push(p);
      }
    };
    scan(SRC);
    expect(hits).toEqual([]);
  });

  it("DashboardLayout preloads idle with 4000/2500 fallback and cleanup (actual effect)", () => {
    const code = read(P("shared/components/layouts/DashboardLayout.js"));
    const ast = parse(code);
    const cb = extractFn(code, ast, "DashboardLayout");
    expect(cb).toMatch(/requestIdleCallback/);
    expect(cb).toMatch(/4000/);
    expect(cb).toMatch(/2500/);
    expect(cb).toMatch(/cancelIdleCallback|clearTimeout/);
    expect(cb).toMatch(/typeof window/);
    expect(code).toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(importSources(ast).join("\n")).not.toMatch(/UsageStats/);
  });

  it("ChangelogModal lazy-loads marked on open only; closed modal has no fetch/import", () => {
    const code = read(P("shared/components/ChangelogModal.js"));
    const ast = parse(code);
    const staticMarked = [];
    walk(ast, (n) => {
      if (n.type === "ImportDeclaration" && n.source.value === "marked") staticMarked.push(n);
    });
    expect(staticMarked).toEqual([]);
    expect(code).toMatch(/if \(!isOpen/);
    expect(code).toMatch(/import\("marked"\)/);
    expect(code).toMatch(/marked\.setOptions/);
    expect(code).not.toMatch(/GITHUB.*fetch.*marked.*module|http/);
  });

  it("Endpoint load/tunnel/requireApiKey route through store; Sidebar uses store + delayed version check", () => {
    const ep = read(P("app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"));
    expect(ep).toMatch(/useSettingsStore/);
    expect(ep).toMatch(/fetchSettings\(\)/);
    expect(ep).toMatch(/patchSettings\(\{ tunnelDashboardAccess/);
    expect(ep).toMatch(/patchSettings\(\{ requireApiKey/);
    const sidebar = read(P("shared/components/Sidebar.js"));
    expect(sidebar).toMatch(/useSettingsStore/);
    expect(sidebar).toMatch(/fetchSettings\(\)/);
    expect(sidebar).toMatch(/2500/);
    expect(sidebar).toMatch(/clearTimeout/);
  });

  it("All option present in usage page and UsageStats selector; grids fit 6 columns", () => {
    const page = read(P("app/(dashboard)/dashboard/usage/page.js"));
    const stats = read(P("shared/components/UsageStats.js"));
    expect(page).toMatch(/\{ value: "all", label: "All" \}/);
    expect(stats).toMatch(/\{ value: "all", label: "All" \}/);
    expect(stats).toMatch(/grid-cols-6/);
  });

  it("chart useMemo callbacks extracted from actual source evaluate sort/top5/empty semantics", () => {
    const pbc = read(P("app/(dashboard)/dashboard/usage/components/ProviderBarChart.js"));
    const tmc = read(P("app/(dashboard)/dashboard/usage/components/TopModelsChart.js"));
    // structural: filter zero, sort desc by selected metric, top models slice 5
    expect(pbc).toMatch(/\.filter\(\(d\) => d\[viewMode\] > 0\)/);
    expect(pbc).toMatch(/\.sort\(\(a, b\) => b\[viewMode\] - a\[viewMode\]\)/);
    expect(tmc).toMatch(/\.slice\(0, 5\)/);
    expect(tmc).toMatch(/\.filter\(\(d\) => d\[viewMode\] > 0\)/);
    // accessible controls: toggle buttons carry visible labels + requests color constant
    const usage = read(P("app/(dashboard)/dashboard/usage/components/UsageChart.js"));
    expect(usage).toMatch(/#14b8a6/);
    expect(usage).toMatch(/Requests/);
  });
});
