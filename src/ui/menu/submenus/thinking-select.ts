/** Two-step thinking override submenu: scope, then thinking level. */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../../types.js";
import type { Theme } from "../../types.js";
import { buildSelectListTheme, createDelegatingComponent } from "../helpers.js";

export interface ThinkingSelectSubmenuOptions {
  showClear: boolean;
  /** Undefined keeps the global selector's full Pi level set. */
  levels?: readonly ThinkingLevel[];
  theme: Theme;
  onSelect: (
    mode: "session" | "permanent" | "clear",
    thinking: ThinkingLevel | undefined,
  ) => void;
}

export function createThinkingSelectSubmenu(
  options: ThinkingSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue, done) => {
    let selectedMode: "session" | "permanent" = "session";
    const modeItems = [
      { value: "session", label: "Set for this session (not saved)" },
      { value: "permanent", label: "Set permanently (saved to config)" },
    ];
    if (options.showClear) modeItems.push({ value: "clear", label: "Clear override" });

    const modeList = new SelectList(modeItems, 5, buildSelectListTheme(options.theme));
    const delegator = createDelegatingComponent(modeList);

    const levels: Array<{ value: string; label: string }> = [
      { value: "inherit", label: "Inherit" },
      ...(options.levels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[])
        .map((level) => ({ value: level, label: level })),
    ];
    const levelList = new SelectList(levels, 8, buildSelectListTheme(options.theme));

    modeList.onSelect = (item) => {
      if (item.value === "clear") {
        options.onSelect("clear", undefined);
        done("clear");
        return;
      }
      selectedMode = item.value as "session" | "permanent";
      delegator.setActive(levelList);
    };
    modeList.onCancel = () => done();

    levelList.onSelect = (item) => {
      const value = item.value === "inherit" ? undefined : item.value as ThinkingLevel;
      options.onSelect(selectedMode, value);
      done(item.value);
    };
    levelList.onCancel = () => done();

    return delegator;
  };
}
