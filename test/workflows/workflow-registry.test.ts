/**
 * workflow-registry.test.ts — Per-call Workflow resolution: the listing session start builds, the
 * one rescan on an unknown name, and the re-read of the named file from current disk (US-31/US-32).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getWorkflowListing,
  resolveWorkflow,
  scanWorkflows,
  setWorkflowScanDirs,
} from "../../src/workflows/workflow-registry.js";
import type { WorkflowResolution } from "../../src/workflows/workflow-registry.js";
import type { WorkflowFolders, WorkflowWarning } from "../../src/workflows/workflow-discovery.js";

const AUDIT = `name: audit
description: Inspect a repository
nodes:
  - id: analysis
    params:
      task_description: "{{task_description}}"
edges: []
entry_node: analysis
`;

let root: string;
let folders: WorkflowFolders;
let warnings: string[];
const warn: WorkflowWarning = (message) => {
  warnings.push(message);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-registry-"));
  warnings = [];
  folders = {
    global: join(root, "agent", "workflows"),
    shared: join(root, "project", ".agents", "workflows"),
    project: join(root, "project", ".pi", "workflows"),
  };
  setWorkflowScanDirs(folders);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(folder: keyof WorkflowFolders, fileName: string, content: string): string {
  const filePath = join(folders[folder], fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function definitionOf(resolution: WorkflowResolution): Record<string, unknown> {
  if (resolution.kind !== "resolved") throw new Error(`expected a resolved workflow, got ${resolution.kind}`);
  return resolution.definition;
}

describe("Workflow resolution", () => {
  it("resolves a listed name to the definition read from its file", async () => {
    const file = write("global", "audit.yaml", AUDIT);
    await scanWorkflows(warn);

    const resolved = await resolveWorkflow("audit", warn);

    expect(resolved).toMatchObject({
      kind: "resolved",
      filePath: file,
      definition: {
        name: "audit",
        description: "Inspect a repository",
        nodes: [{ id: "analysis", params: { task_description: "{{task_description}}" } }],
        edges: [],
        entry_node: "analysis",
      },
    });
  });

  it("resolves the winning file's nodes when two folders declare the same name", async () => {
    write("global", "audit.yaml", AUDIT);
    write("project", "audit.yaml", AUDIT.replace(/analysis/g, "project-node"));
    await scanWorkflows(warn);

    const resolved = await resolveWorkflow("audit", warn);

    expect(JSON.stringify(definitionOf(resolved).nodes)).toContain("project-node");
    expect(JSON.stringify(definitionOf(resolved).nodes)).not.toContain("analysis");
  });

  it("reads the named file again for the next call", async () => {
    const file = write("global", "audit.yaml", AUDIT);
    await scanWorkflows(warn);

    writeFileSync(file, AUDIT.replace("id: analysis", "id: analysis-v2"));
    const resolved = await resolveWorkflow("audit", warn);

    expect(definitionOf(resolved).entry_node).toBe("analysis");
    expect(JSON.stringify(definitionOf(resolved).nodes)).toContain("analysis-v2");
  });

  it("resolves a Workflow file added after the session started", async () => {
    write("global", "audit.yaml", AUDIT);
    await scanWorkflows(warn);
    const added = write("global", "release.yml", AUDIT.replace(/audit/g, "release-review"));

    const resolved = await resolveWorkflow("release-review", warn);

    expect(resolved).toMatchObject({ kind: "resolved", filePath: added, listingChanged: true });
    expect(getWorkflowListing().map((entry) => entry.name)).toEqual(["audit", "release-review"]);
  });

  it("names the available workflows when a rescan still finds no match", async () => {
    write("global", "audit.yaml", AUDIT);
    write("global", "release.yml", AUDIT.replace(/audit/g, "release-review"));
    await scanWorkflows(warn);

    const resolved = await resolveWorkflow("audti", warn);

    expect(resolved).toMatchObject({
      kind: "not-found",
      available: ["audit", "release-review"],
      listingChanged: false,
    });
  });

  it("drops a name whose file stopped declaring it", async () => {
    const file = write("global", "audit.yaml", AUDIT);
    await scanWorkflows(warn);
    writeFileSync(file, AUDIT.replace("name: audit", "name: renamed-audit"));

    const resolved = await resolveWorkflow("audit", warn);

    expect(resolved).toMatchObject({ kind: "not-found", available: ["renamed-audit"], listingChanged: true });
  });

  it("reads the folders only when the name is unknown, and then once", async () => {
    write("global", "audit.yaml", AUDIT);
    await scanWorkflows(warn);
    const scans = vi.spyOn(fs.promises, "readdir");

    await resolveWorkflow("audit", warn);
    await resolveWorkflow("audit", warn);
    expect(scans).not.toHaveBeenCalled();

    // Three folders, one round: a second round would rebuild the tool schema on every call.
    await resolveWorkflow("audti", warn);
    expect(scans).toHaveBeenCalledTimes(3);
  });
});
