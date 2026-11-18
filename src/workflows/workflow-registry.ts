/**
 * workflow-registry.ts — The session's Workflow listing and per-call resolution.
 *
 * Session start scans the folders (trust-gated by the caller); every tool call resolves its name
 * through that listing and re-reads the named file from current disk, with one full rescan when the
 * name is unknown. No cached definitions, no watchers (US-31/US-32).
 */

import { readWorkflowFile, scanWorkflowFiles } from "./workflow-discovery.ts";
import type {
  WorkflowDefinitionFile,
  WorkflowFolders,
  WorkflowListingEntry,
  WorkflowWarning,
} from "./workflow-discovery.ts";

/** Where a resolution landed. `listingChanged` says whether the tool schema needs re-registering. */
export type WorkflowResolution =
  | { kind: "resolved"; filePath: string; definition: Record<string, unknown>; listingChanged: boolean }
  | { kind: "not-found"; available: string[]; listingChanged: boolean };

let folders: WorkflowFolders = { global: "", shared: "", project: "" };
let listing = new Map<string, WorkflowListingEntry>();

/** Set the Workflow folders to scan; an empty path is a folder the caller has gated off. */
export function setWorkflowScanDirs(next: WorkflowFolders): void {
  folders = next;
}

/** Scan the Workflow folders and make the result the session's listing. */
export async function scanWorkflows(warn: WorkflowWarning): Promise<void> {
  listing = await scanWorkflowFiles(folders, warn);
}

/** The current listing, ordered by name. */
export function getWorkflowListing(): WorkflowListingEntry[] {
  return [...listing.values()];
}

/**
 * The listing as the `workflow` parameter describes it: a header plus one `name: description` line
 * per workflow. Callers with an empty listing must not reach for this (the schema keeps that case
 * description-free).
 */
export function formatWorkflowListing(entries: WorkflowListingEntry[]): string {
  const lines = entries.map(({ name, description }) => {
    const trimmed = description.trim();
    return trimmed ? `${name}: ${trimmed}` : name;
  });
  return ["Available workflows:", ...lines].join("\n");
}

/** Resolve a workflow name against the listing, re-reading its file from current disk. */
export async function resolveWorkflow(name: string, warn: WorkflowWarning): Promise<WorkflowResolution> {
  const listed = await readListedFile(name);
  if (listed) {
    return { kind: "resolved", filePath: listed.filePath, definition: listed.definition, listingChanged: false };
  }

  // Exactly one rescan per unknown-name call, never a per-call scan: registering the tool with a
  // changed listing rebuilds the system prompt, so a rescan that changed nothing re-registers nothing.
  const before = formatWorkflowListing(getWorkflowListing());
  listing = await scanWorkflowFiles(folders, warn);
  const listingChanged = formatWorkflowListing(getWorkflowListing()) !== before;

  const found = await readListedFile(name);
  if (found) {
    return { kind: "resolved", filePath: found.filePath, definition: found.definition, listingChanged };
  }
  return { kind: "not-found", available: [...listing.keys()], listingChanged };
}

/** The definition of a listed name, re-read now; folder precedence itself is recomputed only by a scan. */
async function readListedFile(name: string): Promise<WorkflowDefinitionFile | undefined> {
  const entry = listing.get(name);
  if (!entry) return undefined;
  // A stale entry (deleted or renamed file) is answered by the rescan, not by a warning.
  const file = await readWorkflowFile(entry.filePath, () => {});
  return file && file.name === name ? file : undefined;
}
