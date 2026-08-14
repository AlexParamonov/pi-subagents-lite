/**
 * target-select.ts — Shared target-level picker (session/global/project/all).
 *
 * Used by the model settings, concurrency, and spawn-options menus whenever a
 * value can live in more than one layer (ADR-0008). The project entry is
 * offered only when the store says the project target is available; the "All
 * levels" entry is offered for clears.
 */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { buildSelectListTheme, createDelegatingComponent } from "../helpers.js";
import { createConfirmSubmenu } from "./confirm.js";

/** The layer a set/clear applies to; "all" clears every layer. */
export type TargetChoice = "session" | "global" | "project" | "all";

/** Layers a set (non-clear) can target. */
export type SetTarget = "session" | "global" | "project";

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
  return (_currentValue, done) => {
    const items: Array<{ value: string; label: string }> = [];
    if (options.includeSession ?? true) items.push({ value: "session", label: "Session (not saved)" });
    items.push({ value: "global", label: "Global (saves to config)" });
    if (options.projectOffered) items.push({ value: "project", label: "Project (saves to project config)" });
    if (options.showClear) items.push({ value: "clear", label: "Clear..." });
    if (options.includeAll) items.push({ value: "all", label: "All levels" });

    const list = new SelectList(items, 5, buildSelectListTheme(options.theme));
    const delegator = createDelegatingComponent(list);

    list.onSelect = (item) => {
      if (item.value === "clear") {
        // "Clear..." routes to a nested per-level picker; "all" clears every layer.
        delegator.setActive(
          createTargetSelectSubmenu({
            theme: options.theme,
            projectOffered: options.projectOffered,
            includeSession: options.includeSession ?? true,
            includeAll: true,
            onPick: (target, pickDone) => {
              options.onClear?.(target);
              pickDone(target);
            },
          })("", done),
        );
        return;
      }
      const next = options.onPick(item.value as TargetChoice, done);
      if (next) delegator.setActive(next);
      else done(item.value);
    };
    list.onCancel = () => done();

    return delegator;
  };
}

/**
 * Nested clear-all flow shared by the model settings and concurrency menus:
 * pick a level (session/global/project/all), then confirm before applying.
 */
export function createClearAllSubmenu(options: {
  theme: Theme;
  projectOffered: boolean;
  /** Confirm prompt, e.g. "Clear all model overrides at the {target} level?" */
  message: (target: TargetChoice) => string;
  onConfirm: (target: TargetChoice) => void;
}): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (currentValue, done) =>
    createTargetSelectSubmenu({
      theme: options.theme,
      projectOffered: options.projectOffered,
      includeAll: true,
      onPick: (target, pickDone) =>
        createConfirmSubmenu({
          message: options.message(target),
          theme: options.theme,
          onConfirm: () => options.onConfirm(target),
        })(currentValue, pickDone),
    })(currentValue, done);
}
