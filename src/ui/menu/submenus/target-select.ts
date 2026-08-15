/**
 * target-select.ts — Shared target-level picker (session/global/project/all).
 *
 * Used by the model settings, concurrency, and spawn-options menus whenever a
 * value can live in more than one layer (ADR-0008). The project entry is
 * offered only when the store says the project target is available; the "All
 * levels" entry is offered for clears. With an opt-in availableLevels list
 * (model settings only), a level is offered only when it carries the
 * setting, and "All levels" only when at least two levels do.
 */

import { SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { buildSettingsListTheme } from "../helpers.js";
import { createConfirmSubmenu } from "./confirm.js";

/** The layer a set/clear applies to; "all" clears every layer. */
export type TargetChoice = "session" | "global" | "project" | "all";

/** Layers a set (non-clear) can target. */
export type SetTarget = "session" | "global" | "project";

/** Per-level availability of the setting a clear flow removes. */
export interface AvailableLevels {
  session: boolean;
  global: boolean;
  project: boolean;
}

/** Level entries with per-context persistence notes (set vs clear pickers). */
const LEVEL_ENTRIES: Record<SetTarget, { label: string; setDescription: string; clearDescription: string }> = {
  session: {
    label: "Session",
    setDescription: "Not saved",
    clearDescription: "Removes from the session",
  },
  global: {
    label: "Global",
    setDescription: "Saves to the global config file",
    clearDescription: "Removes from the global config file",
  },
  project: {
    label: "Project",
    setDescription: "Saves to the project config file",
    clearDescription: "Removes from the project config file",
  },
};

/** Level row with the description matching the picker's action. */
function levelItem(target: SetTarget, clearMode: boolean): SettingItem {
  const entry = LEVEL_ENTRIES[target];
  return {
    id: target,
    label: entry.label,
    currentValue: "",
    description: clearMode ? entry.clearDescription : entry.setDescription,
  };
}

/**
 * Level rows for a level picker: the offered levels (with the description
 * matching the picker's action) plus optional "Clear..." and "All levels" rows.
 * Clear mode flips the notes to "Removes from..." (see LEVEL_ENTRIES).
 */
export function buildLevelItems(options: {
  /** Which levels get a row. */
  offered: AvailableLevels;
  /** Description wording: set ("Saves to...") vs clear ("Removes from..."). */
  clearMode?: boolean;
  includeClear?: boolean;
  includeAll?: boolean;
}): SettingItem[] {
  const items: SettingItem[] = [];
  if (options.offered.session) items.push(levelItem("session", options.clearMode === true));
  if (options.offered.global) items.push(levelItem("global", options.clearMode === true));
  if (options.offered.project) items.push(levelItem("project", options.clearMode === true));
  if (options.includeClear) items.push({ id: "clear", label: "Clear...", currentValue: "" });
  if (options.includeAll) items.push({ id: "all", label: "All levels", currentValue: "" });
  return items;
}

/**
 * SettingsList-based level picker: bare rows with the selected row's
 * description at the bottom, like the main settings menus. Enter/Space on a
 * row routes through onPick: a returned Component chains as the picker's own
 * submenu (SettingsList manages it); a void return completes the pick.
 */
export function createLevelPickerSubmenu(options: {
  theme: Theme;
  items: SettingItem[];
  onPick: (id: string, done: (selectedValue?: string) => void) => Component | void;
}): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue, done) => {
    const items = options.items.map((item) => ({
      ...item,
      submenu: (cv: string, subDone: (selectedValue?: string) => void): Component => {
        const next = options.onPick(item.id, subDone);
        if (next) return next;
        // No chained step: the pick completes immediately.
        subDone(item.id);
        return null as unknown as Component;
      },
    }));
    const list = new SettingsList(
      items,
      items.length,
      buildSettingsListTheme(options.theme),
      (_id, value) => done(value),
      () => done(),
    );
    // The wrapper reads these two duck-typed members: focused marks the picker
    // as a submenu; getActive exposes the chained step for j/k letter handling.
    const picker = list as SettingsList & { focused: boolean; getActive(): Component | null };
    picker.focused = true;
    picker.getActive = () => (list as any).submenuComponent ?? null;
    return picker;
  };
}

export interface TargetSelectSubmenuOptions {
  theme: Theme;
  /** Show the project entry (trusted project with a valid or absent config file). */
  projectOffered: boolean;
  /** Include the session entry. Default: true. */
  includeSession?: boolean;
  /** Include the "All levels" entry (clears only). Default: false. */
  includeAll?: boolean;
  /** Append a "Clear..." entry that opens a nested per-level clear picker. Default: false. */
  showClear?: boolean;
  /**
   * Opt-in level availability (model-settings clear pickers only): when set,
   * each level is offered only if listed, and "All levels" only if at least
   * two are. When omitted, every structurally available level is offered
   * (the other menus' current behavior).
   */
  availableLevels?: AvailableLevels;
  /**
   * Apply the pick. Return a Component to chain into (value input, confirm);
   * return void to close the submenu (the settings list rebuilds).
   */
  onPick: (target: TargetChoice, done: (selectedValue?: string) => void) => Component | void;
  /** Clear the key at the picked level; required when showClear is set. */
  onClear?: (target: TargetChoice) => void;
}

export function createTargetSelectSubmenu(
  options: TargetSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  const avail = options.availableLevels;
  // Every clear picker includes "All levels" (set pickers never do), so it
  // selects the description wording: "Saves to..." vs "Removes from...".
  const clearMode = options.includeAll === true;
  const sessionOffered = (options.includeSession ?? true) && (!avail || avail.session);
  const globalOffered = !avail || avail.global;
  const projectOffered = options.projectOffered && (!avail || avail.project);
  const levelsOffered = [sessionOffered, globalOffered, projectOffered].filter(Boolean).length;
  const items = buildLevelItems({
    offered: { session: sessionOffered, global: globalOffered, project: projectOffered },
    clearMode,
    includeClear: options.showClear === true,
    includeAll: avail ? levelsOffered >= 2 : options.includeAll === true,
  });

  return createLevelPickerSubmenu({
    theme: options.theme,
    items,
    onPick: (id, subDone) => {
      if (id === "clear") {
        // "Clear..." routes to a nested per-level picker; "all" clears every layer.
        return createClearPickerSubmenu({
          theme: options.theme,
          projectOffered: options.projectOffered,
          includeSession: options.includeSession ?? true,
          availableLevels: options.availableLevels,
          onClear: (target) => options.onClear?.(target),
        })("", subDone);
      }
      return options.onPick(id as TargetChoice, subDone);
    },
  });
}

/**
 * Nested per-level clear picker ("Clear..." → pick a level): the shared
 * target picker restricted to levels with the setting, plus "All levels".
 */
export function createClearPickerSubmenu(options: {
  theme: Theme;
  projectOffered: boolean;
  includeSession?: boolean;
  availableLevels?: AvailableLevels;
  onClear: (target: TargetChoice) => void;
}): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return createTargetSelectSubmenu({
    theme: options.theme,
    projectOffered: options.projectOffered,
    includeSession: options.includeSession ?? true,
    includeAll: true,
    availableLevels: options.availableLevels,
    onPick: (target) => options.onClear(target),
  });
}

/**
 * Nested clear-all flow shared by the model settings and concurrency menus:
 * pick a level (session/global/project/all), then confirm before applying.
 */
export function createClearAllSubmenu(options: {
  theme: Theme;
  projectOffered: boolean;
  /** Opt-in level availability; see TargetSelectSubmenuOptions.availableLevels. */
  availableLevels?: AvailableLevels;
  /** Confirm prompt, e.g. "Clear all model overrides at the {target} level?" */
  message: (target: TargetChoice) => string;
  onConfirm: (target: TargetChoice) => void;
}): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (currentValue, done) =>
    createTargetSelectSubmenu({
      theme: options.theme,
      projectOffered: options.projectOffered,
      includeAll: true,
      availableLevels: options.availableLevels,
      onPick: (target, pickDone) =>
        createConfirmSubmenu({
          message: options.message(target),
          theme: options.theme,
          onConfirm: () => options.onConfirm(target),
        })(currentValue, pickDone),
    })(currentValue, done);
}
