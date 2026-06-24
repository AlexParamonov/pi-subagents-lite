/**
 * searchable-select.ts — TUI paginated, searchable pick-list dialog.
 *
 * Reuses the same building blocks as pi's ModelSelectorComponent but without
 * the SettingsManager dependency — no side effects, just callbacks.
 */

import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SelectOption {
  /** The value returned on selection (e.g. "provider/model-id"). */
  value: string;
  /** Display label. */
  label: string;
  /** Provider name for badge; omitted when the label already conveys it (e.g. provider/type lists). */
  provider?: string;
}

interface SelectDialogCallbacks {
  onSelect: (value: string) => void;
  onCancel: () => void;
}

/* ------------------------------------------------------------------ */
/*  SearchableSelectDialog                                             */
/* ------------------------------------------------------------------ */

const MAX_VISIBLE = 10;

/**
 * A paginated, searchable selection dialog.
 *
 * Rendering mirrors pi's ModelSelectorComponent:
 *   - Top border
 *   - Search input
 *   - Paginated option list (10 at a time, centered on selection)
 *   - Scroll indicator "(3/47)"
 *   - Bottom border
 *
 * Key bindings: up/down/pageup/pagedown/enter/escape + pass-through to search.
 */
export class SearchableSelectDialog extends Container implements Focusable {
  private searchInput: Input;
  private listContainer: Container;
  private items: SelectOption[];
  private filteredItems: SelectOption[];
  private selectedIndex: number;
  private currentValue: string | null;
  private callbacks: SelectDialogCallbacks;
  private theme: Theme;

  // Focusable implementation — propagate to searchInput for IME cursor
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    items: SelectOption[],
    currentValue: string | null,
    callbacks: SelectDialogCallbacks,
    theme: Theme,
  ) {
    super();

    this.items = items;
    this.currentValue = currentValue;
    this.callbacks = callbacks;
    this.theme = theme;
    this.filteredItems = [...items];

    // Pre-select current value if present
    const currentIdx = items.findIndex((m) => m.value === currentValue);
    this.selectedIndex = currentIdx >= 0 ? currentIdx : 0;

    // Build UI
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      if (this.filteredItems[this.selectedIndex]) {
        this.callbacks.onSelect(this.filteredItems[this.selectedIndex].value);
      }
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(new DynamicBorder());

    this.updateList();
  }

  /** Handle keyboard input. Delegates non-navigation keys to searchInput. */
  handleInput(keyData: string): void {
    const kb = getKeybindings();

    // Navigation keys — no-op when list is empty
    if (this.filteredItems.length === 0) {
      if (
        kb.matches(keyData, "tui.select.up") ||
        kb.matches(keyData, "tui.select.down") ||
        kb.matches(keyData, "tui.select.pageUp") ||
        kb.matches(keyData, "tui.select.pageDown")
      ) {
        return;
      }
    }

    // Up — wrap to bottom
    if (kb.matches(keyData, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    // Down — wrap to top
    if (kb.matches(keyData, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    // PageUp — jump up one page
    if (kb.matches(keyData, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE);
      this.updateList();
      return;
    }

    // PageDown — jump down one page
    if (kb.matches(keyData, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(
        this.filteredItems.length - 1,
        this.selectedIndex + MAX_VISIBLE,
      );
      this.updateList();
      return;
    }

    // Enter — confirm selection
    if (kb.matches(keyData, "tui.select.confirm")) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected) {
        this.callbacks.onSelect(selected.value);
      }
      return;
    }

    // Escape / Ctrl+C — cancel
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.callbacks.onCancel();
      return;
    }

    // Everything else → search input (triggers fuzzy filter)
    this.searchInput.handleInput(keyData);
    this.filterItems();
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  private filterItems(): void {
    const query = this.searchInput.getValue();
    if (!query) {
      this.filteredItems = [...this.items];
    } else {
      this.filteredItems = fuzzyFilter(
        this.items,
        query,
        (item) => `${item.label} ${item.provider} ${item.value}`,
      );
    }
    // Clamp selection index
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredItems.length - 1),
    );
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    const { filteredItems } = this;
    if (filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching items"), 0, 0),
      );
      return;
    }

    // Centered scroll window
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
        filteredItems.length - MAX_VISIBLE,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE, filteredItems.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = filteredItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const isCurrent = item.value === this.currentValue;

      const labelText = isSelected
        ? this.theme.fg("accent", "→ ") + this.theme.fg("accent", item.label)
        : `  ${item.label}`;
      const providerBadge = item.provider ? this.theme.fg("muted", `[${item.provider}]`) : "";
      const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
      const line = `${labelText} ${providerBadge}${checkmark}`;

      this.listContainer.addChild(new Text(line, 0, 0));
    }

    // Scroll indicator when not all items visible
    if (startIndex > 0 || endIndex < filteredItems.length) {
      const scrollInfo = this.theme.fg(
        "muted",
        `  (${this.selectedIndex + 1}/${filteredItems.length})`,
      );
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }
  }
}
