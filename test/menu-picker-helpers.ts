/**
 * menu-picker-helpers.ts — Shared simulation of SettingsList.activateItem for
 * the mocked SettingsList classes in menu tests.
 *
 * The level pickers (target-select's createLevelPickerSubmenu) route row
 * activation through SettingItem.submenu factories. The real SettingsList runs
 * the factory, stores the returned step as its submenuComponent, and on
 * completion writes the picked value into the row and fires onChange. This
 * helper does the same against the mock instances, so tests can drive pickers
 * faithfully without duplicating the wiring in every mock class.
 */
import type { Component, SettingItem } from "@earendil-works/pi-tui";

/** The public surface of the mocked SettingsList the picker simulation drives. */
export interface SettingsListView {
  items: SettingItem[];
  submenuComponent: Component | null;
  onChange: (id: string, newValue: string) => void;
}

export function activatePickerRow(list: SettingsListView, id: string): void {
  const found = list.items.find((i) => i.id === id);
  // Consts so the non-null-asserted bindings keep their narrowed types
  // inside the callback (a bare union would lose them in the closure).
  const item = found!;
  const submenu = item.submenu!;
  list.submenuComponent = submenu(item.currentValue, (value?: string) => {
    if (value !== undefined) {
      item.currentValue = value;
      list.onChange(item.id, value);
    }
    list.submenuComponent = null;
  });
}
