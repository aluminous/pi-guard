import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";

export type Theme = {
  fg(name: string, text: string): string;
};

export type Keybindings = {
  matches(keyData: string, keyId: string): boolean;
};

export interface SelectItem<V> {
  value: V;
  label: string;
  searchText: string;
  description?: string;
  /** Muted suffix rendered after the label, e.g. a provider tag. */
  suffix?: string;
  /** Marks the item as the currently active choice (rendered with a check). */
  current?: boolean;
}

/**
 * Searchable single-select list with optional static header lines. Generic
 * over the item value; used by the guard control panel and the classifier
 * model selector.
 */
interface SelectListParams<V> {
  title: string;
  headerLines?: string[];
  items: SelectItem<V>[];
  theme: Theme;
  keybindings: Keybindings;
  done: (value: SelectItem<V> | undefined) => void;
}

export class SearchableSelectList<V> extends Container {
  private searchInput = new Input();
  private listContainer = new Container();
  private filtered: SelectItem<V>[] = [];
  private selectedIndex = 0;
  private _focused = false;
  private params: SelectListParams<V>;

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(params: SelectListParams<V>) {
    super();
    this.params = params;
    this.filtered = params.items;
    this.addChild(new Text(params.theme.fg("accent", params.title), 0, 0));
    for (const line of params.headerLines ?? []) {
      this.addChild(new Text(params.theme.fg("muted", line), 0, 0));
    }
    this.addChild(new Text(this.params.theme.fg("muted", "Type to search. Enter selects. Escape cancels."), 0, 0));
    this.addChild(new Spacer(1));
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.updateList();
  }

  private filter(query: string) {
    this.filtered = query ? fuzzyFilter(this.params.items, query, (item) => item.searchText) : this.params.items;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.updateList();
  }

  private selectCurrent() {
    const selected = this.filtered[this.selectedIndex];
    if (selected) this.params.done(selected);
  }

  private updateList() {
    const theme = this.params.theme;
    this.listContainer.clear();
    const maxVisible = 10;
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filtered[i];
      if (!item) continue;
      const selected = i === this.selectedIndex;
      const prefix = selected ? theme.fg("accent", "→ ") : "  ";
      const label = selected ? theme.fg("accent", item.label) : item.label;
      const suffixParts: string[] = [];
      if (item.suffix) suffixParts.push(theme.fg("muted", item.suffix));
      if (item.current) suffixParts.push(theme.fg("success", "✓"));
      const suffix = suffixParts.length ? ` ${suffixParts.join(" ")}` : "";
      this.listContainer.addChild(new Text(`${prefix}${label}${suffix}`, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filtered.length) {
      this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
    }

    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(theme.fg("muted", "  No matches"), 0, 0));
      return;
    }

    const selected = this.filtered[this.selectedIndex];
    if (selected?.description) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(theme.fg("muted", `  ${selected.description}`), 0, 0));
    }
  }

  handleInput(keyData: string): void {
    if (this.params.keybindings.matches(keyData, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (this.params.keybindings.matches(keyData, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (this.params.keybindings.matches(keyData, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }

    if (this.params.keybindings.matches(keyData, "tui.select.cancel")) {
      this.params.done(undefined);
      return;
    }

    this.searchInput.handleInput(keyData);
    this.filter(this.searchInput.getValue());
  }
}

export interface CustomUiHost {
  ui: {
    custom<T>(factory: (tui: unknown, theme: Theme, keybindings: Keybindings, done: (value: T) => void) => unknown): Promise<T | undefined>;
  };
}

export async function pickFromList<V>(
  ctx: CustomUiHost,
  params: { title: string; headerLines?: string[]; items: SelectItem<V>[] },
): Promise<SelectItem<V> | undefined> {
  return ctx.ui.custom<SelectItem<V> | undefined>(
    (_tui, theme, keybindings, done) => new SearchableSelectList<V>({ ...params, theme, keybindings, done }),
  );
}
