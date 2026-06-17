Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/ui/menu/menu-helpers.ts`
- `src/ui/menu/menu-widget-settings.ts`
- `test/menu-widget-settings.test.ts`
- `test/menus.test.ts`
- `test/build-settings-list-theme.test.ts`
- `test/validate-numeric.test.ts`

Issues found:
- 0 critical, 2 important, 0 suggestions

The implementation correctly migrates from `runMenuLoop`/`ctx.ui.select` to `SettingsList`/`ctx.ui.custom`, which fixes the cursor position reset bug. The `validateNumeric` extraction and `buildSettingsListTheme` helper are clean. Tests pass and typecheck is clean.

## [IMPORTANT] Dead code: unused `setter` field in `buildStatToggleItems`

Confidence: 90/100
Location: `src/ui/menu/menu-widget-settings.ts:22-31`

Problem: `buildStatToggleItems` defines a `setter` field on each stat toggle object but never uses it. The `.map()` on line 33 only extracts `id`, `label`, and `currentValue` (via `getter()`). The `setter` closures are dead code.

Meanwhile, the `onChange` function (lines 56-92) duplicates the same store mutation logic via a hardcoded switch statement.

Why it matters: The `setter` field was clearly intended to drive `onChange` in a data-driven way. Having both dead `setter` definitions and a parallel hardcoded switch creates a maintenance trap: adding a new stat requires updating two places (the `statToggles` array and the `onChange` switch), and a developer might update one and forget the other.

Fix: Either use the `setter` in `onChange` to avoid duplication, or remove the `setter` field entirely since `onChange` handles it. Using `setter` is cleaner:

```typescript
function buildStatToggleItems(
  store: ReturnType<typeof getStore>,
): Array<SettingItem & { setter: (v: boolean) => void }> {
  // ... keep setter in the returned items
}

// Then in onChange:
const statItem = statItems.find((s) => s.id === id);
if (statItem) {
  statItem.setter(newValue === "ON");
  ctx.ui.notify(`${statItem.label} ${newValue}`, "info");
  break;
}
```

## [IMPORTANT] Weak `buildSettingsListTheme` tests don't verify styling behavior

Confidence: 85/100
Location: `test/build-settings-list-theme.test.ts`

Problem: Every test in the file uses `.toContain(text)` to verify the return value. The mock theme produces distinctive, verifiable output:

```typescript
fg: (color, text) => `<${color}>${text}</${color}>`
bold: (text) => `**${text}**`
italic: (text) => `_${text}_`
```

So `label("Test", true)` should produce `**<accent>Test</accent>**`, but the test only checks `.toContain("Test")`. This means the tests would pass if every styling function returned plain unstyled text. The test names claim to verify styling ("applies accent color when selected", "applies styling when selected") but don't actually assert it.

Why it matters: These tests create false confidence. They'd pass even if someone accidentally reverted all the styling logic. The mock theme was clearly set up to enable exact output verification but isn't used that way.

Fix: Verify the actual styled output:

```typescript
it("label applies bold + accent when selected", () => {
  const theme = buildSettingsListTheme(createMockTheme());
  expect(theme.label("Test", true)).toBe("**<accent>Test</accent>**");
});

it("label returns plain text when not selected", () => {
  const theme = buildSettingsListTheme(createMockTheme());
  expect(theme.label("Test", false)).toBe("Test");
});

it("value uses accent when selected, muted when not", () => {
  const theme = buildSettingsListTheme(createMockTheme());
  expect(theme.value("ON", true)).toBe("<accent>ON</accent>");
  expect(theme.value("ON", false)).toBe("<muted>ON</muted>");
});

it("description uses italic + muted", () => {
  const theme = buildSettingsListTheme(createMockTheme());
  expect(theme.description("desc")).toBe("_<muted>desc</muted>_");
});

it("cursor uses accent", () => {
  const theme = buildSettingsListTheme(createMockTheme());
  expect(theme.cursor).toBe("<accent>></accent>");
});

it("hint uses dim", () => {
  const theme = buildSettingsListTheme(createMockTheme());
  expect(theme.hint("text")).toBe("<dim>text</dim>");
});
```
