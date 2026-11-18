/**
 * workflow-discovery.test.ts — Workflow file discovery: YAML parsing, invalid-file skipping,
 * whole-file precedence and same-folder duplicate resolution.
 *
 * Drives the real folders on disk: the scan is the seam, so precedence and the warnings a
 * developer sees are the ones the extension's session-start scan produces.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { scanWorkflowFiles } from "../../src/workflows/workflow-discovery.js";

/** A graph-schema Workflow file: nested nodes, `{{...}}` interpolation strings, no frontmatter. */
const AUDIT = `name: audit
description: Inspect a repository
nodes:
  - id: analysis
    params:
      task_description: "{{task_description}}"
      working_dir: "{{working_dir}}"
edges:
  - from: analysis
    to: report
entry_node: analysis
`;

let root: string;
let dirs: { global: string; shared: string; project: string };
let warnings: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-discovery-"));
  dirs = {
    global: join(root, "agent", "workflows"),
    shared: join(root, "project", ".agents", "workflows"),
    project: join(root, "project", ".pi", "workflows"),
  };
  warnings = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativeDir: keyof typeof dirs, fileName: string, content: string): string {
  const filePath = join(dirs[relativeDir], fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function scan() {
  return scanWorkflowFiles(dirs, (message) => warnings.push(message));
}

function named(description: string, node: string, name = "audit"): string {
  return `name: ${name}\ndescription: ${description}\nnodes:\n  - id: ${node}\nedges: []\nentry_node: ${node}\n`;
}

describe("Workflow file discovery", () => {
  it("reads the name and description of a graph-schema Workflow file", async () => {
    const file = write("global", "audit.yaml", AUDIT);

    const listing = await scan();

    expect([...listing.values()]).toEqual([{ name: "audit", description: "Inspect a repository", filePath: file }]);
    expect(warnings).toEqual([]);
  });

  it("replaces a same-named global and shared file with the project one", async () => {
    write("global", "audit.yaml", named("Global audit", "global-node"));
    write("shared", "audit.yml", named("Shared audit", "shared-node"));
    const projectFile = write("project", "audit.yaml", named("Project audit", "project-node"));

    const listing = await scan();

    expect([...listing.values()]).toEqual([{ name: "audit", description: "Project audit", filePath: projectFile }]);
    expect(warnings).toEqual([]);
  });

  it("replaces a same-named global file with the shared one", async () => {
    write("global", "audit.yaml", named("Global audit", "global-node"));
    const sharedFile = write("shared", "audit.yml", named("Shared audit", "shared-node"));

    const listing = await scan();

    expect([...listing.values()]).toEqual([{ name: "audit", description: "Shared audit", filePath: sharedFile }]);
  });

  it("reads both extensions", async () => {
    const yamlFile = write("global", "audit.yaml", named("From yaml", "analysis"));
    const ymlFile = write("global", "release.yml", named("From yml", "release", "release"));

    const listing = await scan();

    expect(listing.get("audit")?.filePath).toBe(yamlFile);
    expect(listing.get("release")?.filePath).toBe(ymlFile);
  });

  it("ignores files that are not Workflow files", async () => {
    write("global", "README.md", "Notes about the workflows in this folder.\n");
    write("global", "audit.yaml", named("A workflow", "analysis"));

    const listing = await scan();

    expect([...listing.keys()]).toEqual(["audit"]);
  });

  it("returns nothing when a folder does not exist", async () => {
    const listing = await scan();

    expect([...listing.values()]).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("skips a folder whose path is empty", async () => {
    write("global", "audit.yaml", named("A workflow", "analysis"));

    const listing = await scanWorkflowFiles({ ...dirs, project: "", shared: "" }, (message) => warnings.push(message));

    expect([...listing.keys()]).toEqual(["audit"]);
    expect(warnings).toEqual([]);
  });

  it("warns and skips a file whose YAML cannot be parsed, keeping the valid ones", async () => {
    write("global", "bad-workflow.yaml", "name: [unterminated\n");
    const valid = write("global", "valid.yml", named("A workflow", "analysis"));

    const listing = await scan();

    expect([...listing.values()]).toEqual([{ name: "audit", description: "A workflow", filePath: valid }]);
    expect(warnings.join("\n")).toContain("bad-workflow.yaml");
  });

  for (const [label, content] of [
    ["missing name", "description: No name here\nnodes: []\nedges: []\n"],
    ["empty name", 'name: ""\ndescription: Empty name\n'],
    ["non-string name", "name: 42\ndescription: Numeric name\n"],
    ["no YAML document at all", ""],
    ["a YAML list at the top level", "- name: audit\n"],
  ] as const) {
    it(`warns and skips a file with a ${label}`, async () => {
      write("global", "broken.yaml", content);

      const listing = await scan();

      expect([...listing.values()]).toEqual([]);
      expect(warnings.join("\n")).toContain("broken.yaml");
    });
  }

  it("lists workflows by name whichever folder they came from", async () => {
    write("global", "zulu.yaml", named("Global zulu", "z", "zulu"));
    write("project", "alpha.yaml", named("Project alpha", "a", "alpha"));

    const listing = await scan();

    expect([...listing.keys()]).toEqual(["alpha", "zulu"]);
  });

  it("warns when a Workflow file cannot be read", async () => {
    mkdirSync(join(dirs.global, "subfolder.yaml"), { recursive: true });

    const listing = await scan();

    expect([...listing.values()]).toEqual([]);
    expect(warnings.join("\n")).toContain("subfolder.yaml");
  });

  it("lets the later alphabetical file win when one folder holds the same name twice", async () => {
    write("global", "a-audit.yaml", named("Earlier definition", "first-node"));
    const later = write("global", "z-audit.yml", named("Later definition", "second-node"));

    const listing = await scan();

    expect([...listing.values()]).toEqual([{ name: "audit", description: "Later definition", filePath: later }]);
    expect(warnings.join("\n")).toMatch(/duplicate/i);
    expect(warnings.join("\n")).toContain("audit");
  });
});
