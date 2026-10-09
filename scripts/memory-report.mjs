#!/usr/bin/env node
// 度量 Prism 自身进程与终端里用户任务的内存，口径分开，避免把 dev server 算进编辑器。
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

const isMac = platform() === "darwin";

function parseArgs(argv) {
  const out = { json: false, withPty: false, pid: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--with-pty") out.withPty = true;
    else if (arg === "--pid") {
      out.pid = Number(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function psRows() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss: Number(match[3]) * 1024,
      command: match[4] ?? "",
    });
  }
  return rows;
}

function pgrepPrism() {
  try {
    const text = execFileSync("pgrep", ["-x", "prismcode"], { encoding: "utf8" });
    return text
      .split("\n")
      .map((item) => Number(item.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

function parseSize(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const normalized = (unit || "B").toUpperCase();
  const scale =
    normalized === "TB"
      ? 1024 ** 4
      : normalized === "GB"
        ? 1024 ** 3
        : normalized === "MB"
          ? 1024 ** 2
          : normalized === "KB"
            ? 1024
            : 1;
  return Math.round(amount * scale);
}

function footprintOf(pid) {
  if (!isMac) return { bytes: null, shared: [] };
  try {
    const text = execFileSync("footprint", [String(pid)], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const match = text.match(
      /phys(?:ical)?[_\s]+footprint:\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?B|bytes)?/i,
    );
    const unit = match?.[2] && match[2].toLowerCase() === "bytes" ? "B" : match?.[2];
    const bytes = match ? parseSize(match[1], unit) : null;
    const sharedSection = text.split(/shared with:?/i)[1] ?? "";
    const shared = [];
    for (const item of sharedSection.matchAll(/prismcode\s*\[(\d+)\]/gi)) {
      shared.push(Number(item[1]));
    }
    return { bytes, shared };
  } catch {
    return { bytes: null, shared: [] };
  }
}

function descendants(rows, roots) {
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

function formatBytes(bytes) {
  if (bytes == null) return "n/a";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function isWebKit(command) {
  return (
    command.includes("com.apple.WebKit.WebContent") ||
    command.includes("com.apple.WebKit.GPU") ||
    command.includes("com.apple.WebKit.Networking")
  );
}

function measure(list) {
  return list.map((proc) => ({
    ...proc,
    footprint: isMac ? (footprintOf(proc.pid).bytes ?? proc.rss) : null,
  }));
}

function sumFootprint(list) {
  if (!isMac) return null;
  return list.reduce((total, proc) => total + (proc.footprint ?? 0), 0);
}

function main() {
  const args = parseArgs(process.argv);
  const rows = psRows();
  let roots = args.pid ? [args.pid] : pgrepPrism();
  if (!roots.length) {
    roots = rows
      .filter((row) => /(^|[/\s])prismcode(\s|$)/.test(row.command))
      .map((row) => row.pid);
  }
  const rootSet = new Set(roots);
  const tree = descendants(rows, roots);
  const javaProcs = rows.filter((row) => row.command.includes("org.eclipse.equinox.launcher"));
  const javaPids = new Set(javaProcs.map((row) => row.pid));
  const mainMeasured = measure(rows.filter((row) => rootSet.has(row.pid)));
  const javaMeasured = measure(javaProcs);
  const terminalMeasured = measure(
    rows.filter(
      (row) =>
        tree.has(row.pid) &&
        !rootSet.has(row.pid) &&
        !javaPids.has(row.pid) &&
        !isWebKit(row.command),
    ),
  );

  const prismWebkit = [];
  const otherWebkit = [];
  if (isMac) {
    for (const proc of rows.filter((row) => isWebKit(row.command))) {
      const info = footprintOf(proc.pid);
      const item = { ...proc, footprint: info.bytes };
      if (info.shared.some((pid) => rootSet.has(pid))) prismWebkit.push(item);
      else otherWebkit.push(item);
    }
  }

  const groups = [
    { category: "Prism 主进程", procs: mainMeasured, note: "pgrep -x prismcode 命中的主进程" },
    {
      category: "WebKit（归属 Prism）",
      procs: prismWebkit,
      note: "footprint 的 Shared with 含 prismcode",
    },
    { category: "其他 WebKit 应用", procs: otherWebkit, note: "不属于 Prism 的 WebKit 辅助进程" },
    {
      category: "Java 语言服务",
      procs: javaMeasured,
      note: "命令行含 org.eclipse.equinox.launcher",
    },
    {
      category: "终端里运行的用户任务（不属于 Prism 自身）",
      procs: terminalMeasured,
      note: "主进程树里的终端子进程，不含 Java 语言服务",
    },
  ];
  const table = groups.map((group) => ({
    category: group.category,
    count: group.procs.length,
    footprint: sumFootprint(group.procs),
    rss: group.procs.reduce((total, proc) => total + proc.rss, 0),
    note: group.note,
  }));
  const prismTotal = isMac
    ? sumFootprint([...mainMeasured, ...prismWebkit, ...javaMeasured])
    : null;
  const terminalTotal = sumFootprint(terminalMeasured);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          rows: table,
          prismTotal,
          terminalTotal,
          pty: args.withPty
            ? terminalMeasured.map((proc) => ({
                pid: proc.pid,
                ppid: proc.ppid,
                rss: proc.rss,
                footprint: proc.footprint,
                command: proc.command,
              }))
            : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [
    "| 进程类 | 进程数 | phys_footprint 合计 | 说明 |",
    "|---|---:|---:|---|",
    ...table.map(
      (row) => `| ${row.category} | ${row.count} | ${formatBytes(row.footprint)} | ${row.note} |`,
    ),
    "",
    `Prism 自身合计：${formatBytes(prismTotal)}（主进程 + 归到 Prism 的 WebKit 辅助进程 + Java 语言服务）`,
    `终端子进程合计：${formatBytes(terminalTotal)}`,
  ];
  if (!isMac) {
    lines.push("");
    lines.push("非 macOS：footprint 与 WebKit 归属不可用，phys_footprint 列为 n/a。ps RSS 聚合：");
    for (const row of table) {
      lines.push(`- ${row.category}：${row.count} 个进程，RSS ${formatBytes(row.rss)}`);
    }
  }
  if (args.withPty) {
    lines.push("");
    lines.push("终端子进程：");
    if (!terminalMeasured.length) lines.push("- （无）");
    for (const proc of terminalMeasured) {
      lines.push(`- ${proc.pid} ppid=${proc.ppid} rss=${formatBytes(proc.rss)} ${proc.command}`);
    }
  }
  console.log(lines.join("\n"));
}

main();
