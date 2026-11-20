/**
 * workflow-discovery.ts — Workflow file reading: real YAML in graph's own schema, discovered from
 * `~/.pi/agent/workflows/`, `<project>/.agents/workflows/` and `<project>/.pi/workflows/`.
 * Whole-file precedence (the flat agent frontmatter parser cannot read this schema).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { record } from "./payload.ts";

/** One Workflow file as the listing holds it: metadata only, never the definition (US-32). */
export interface WorkflowListingEntry {
  name: string;
  description: string;
  filePath: string;
}

/** A Workflow file read at call time: its listing metadata plus the parsed definition. */
export interface WorkflowDefinitionFile extends WorkflowListingEntry {
  definition: Record<string, unknown>;
}

/** Where a skipped or shadowed Workflow file is announced to the user. */
export type WorkflowWarning = (message: string) => void;

/** The three Workflow folders; an empty path means that folder is not scanned (trust gating). */
export interface WorkflowFolders {
  global: string;
  shared: string;
  project: string;
}

/**
 * Read the Workflow folders in precedence order (project > shared > global), whole file per name.
 * The returned listing is ordered by name, so the roster does not depend on which folder won.
 */
export async function scanWorkflowFiles(
  folders: WorkflowFolders,
  warn: WorkflowWarning,
): Promise<Map<string, WorkflowListingEntry>> {
  const listing = new Map<string, WorkflowListingEntry>();
  for (const entry of await readFolder(folders.global, warn)) listing.set(entry.name, entry);
  for (const entry of await readFolder(folders.shared, warn)) listing.set(entry.name, entry);
  for (const entry of await readFolder(folders.project, warn)) listing.set(entry.name, entry);
  return new Map([...listing].sort(([a], [b]) => a.localeCompare(b)));
}

/** One folder's Workflow files, in alphabetical order; a later file replaces an earlier same-named one. */
async function readFolder(dir: string, warn: WorkflowWarning): Promise<WorkflowListingEntry[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));
  } catch {
    return [];
  }

  const folder = new Map<string, WorkflowDefinitionFile>();
  for (const name of names.sort()) {
    const filePath = path.join(dir, name);
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch (error) {
      warn(`Workflow file "${name}" could not be read: ${firstLine(error)}`);
      continue;
    }
    const file = parseWorkflowFile(content, filePath, warn);
    if (!file) continue;
    const shadowed = folder.get(file.name);
    if (shadowed) {
      warn(
        `Duplicate workflow name "${file.name}" in ${dir}: ${path.basename(shadowed.filePath)} is replaced by ${name}.`,
      );
    }
    folder.set(file.name, file);
  }
  return [...folder.values()].map(({ name, description, filePath }) => ({ name, description, filePath }));
}

/**
 * Read one Workflow file from current disk. A file that cannot be read at all is reported by the
 * caller's next scan (its name leaves the listing), so only content defects are worth a warning.
 */
export async function readWorkflowFile(
  filePath: string,
  warn: WorkflowWarning,
): Promise<WorkflowDefinitionFile | undefined> {
  const content = await fs.promises.readFile(filePath, "utf-8").catch(() => undefined);
  return content === undefined ? undefined : parseWorkflowFile(content, filePath, warn);
}

/** A Workflow file's parsed definition and listing metadata; nothing when the YAML has no usable `name`. */
function parseWorkflowFile(
  content: string,
  filePath: string,
  warn: WorkflowWarning,
): WorkflowDefinitionFile | undefined {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    warn(skipMessage(filePath, `is not valid YAML: ${firstLine(error)}`));
    return undefined;
  }

  const document = record(parsed);
  const rawName = document?.name;
  if (!document || typeof rawName !== "string" || rawName.trim() === "") {
    warn(skipMessage(filePath, "has no non-empty string name"));
    return undefined;
  }

  const description = document.description;
  return {
    name: rawName.trim(),
    description: typeof description === "string" ? description : "",
    filePath,
    definition: document,
  };
}

/** The message for a file the scan skips; the caller's sink decides where it is shown. */
function skipMessage(filePath: string, reason: string): string {
  return `Skipping workflow file "${path.basename(filePath)}" because it ${reason}.`;
}

/** YAML and OS error messages carry a code frame or a stack; only their first line reads well in a notice. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
}
