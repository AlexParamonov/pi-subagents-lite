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
export function activatePickerRow(list: any, id: string): void {
  const item = list.items.find((i: any) => i.id === id);
  list.submenuComponent = item.submenu(item.currentValue, (value?: string) => {
    if (value !== undefined) {
      item.currentValue = value;
      list.onChange(item.id, value);
    }
    list.submenuComponent = null;
  });
}
