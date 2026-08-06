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
 * One tab of a tabbed list: its own items and its own header lines, so the
 * lines above the search box can describe the target being picked.
 */
export interface SelectTab<V> {
  id: string;
  label: string;
  headerLines?: string[];
  items: SelectItem<V>[];
}

/** The tabbed and untabbed sources normalize to this before anything renders. */
interface SelectSource<V> {
  title: string;
  headerLines?: string[];
  /** Single-list source; ignored when `tabs` is given. */
  items?: SelectItem<V>[];
  /** Tabbed source: Tab cycles between them, mirroring pi's /model scope line. */
  tabs?: SelectTab<V>[];
}

/** A one-tab view of a plain item list, so the render path has a single shape. */
function normalizeTabs<V>(source: SelectSource<V>): SelectTab<V>[] {
  if (source.tabs && source.tabs.length > 0) return source.tabs;
  return [{ id: "", label: "", items: source.items ?? [] }];
}

/**
 * Searchable single-select list with optional static header lines and optional
 * tabs. Generic over the item value; used by the rail control panel and the
 * classifier model selector.
 */
interface SelectListParams<V> extends SelectSource<V> {
  theme: Theme;
  keybindings: Keybindings;
  done: (value: SelectItem<V> | undefined) => void;
}

export class SearchableSelectList<V> extends Container {
  private searchInput = new Input();
  private headerContainer = new Container();
  private listContainer = new Container();
  private tabs: SelectTab<V>[];
  private tabIndex = 0;
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
    this.tabs = normalizeTabs(params);
    this.filtered = this.items();
    this.addChild(this.headerContainer);
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.updateHeader();
    this.updateList();
  }

  /** The active tab's id; "" for an untabbed list. Drives callers that route by target. */
  activeTab(): string {
    return this.tabs[this.tabIndex]!.id;
  }

  private items(): SelectItem<V>[] {
    return this.tabs[this.tabIndex]!.items;
  }

  private tabbed(): boolean {
    return this.tabs.length > 1;
  }

  /** `Tab: namer | judge` with the active word accented, like pi's model-selector scope line. */
  private renderTabHeader(): string {
    const theme = this.params.theme;
    const names = this.tabs.map((tab, index) => theme.fg(index === this.tabIndex ? "accent" : "muted", tab.label));
    return `${theme.fg("muted", "Tab:")} ${names.join(theme.fg("muted", " | "))}`;
  }

  private updateHeader() {
    const theme = this.params.theme;
    this.headerContainer.clear();
    this.headerContainer.addChild(new Text(theme.fg("accent", this.params.title), 0, 0));
    if (this.tabbed()) this.headerContainer.addChild(new Text(this.renderTabHeader(), 0, 0));
    for (const line of [...(this.params.headerLines ?? []), ...(this.tabs[this.tabIndex]!.headerLines ?? [])]) {
      this.headerContainer.addChild(new Text(theme.fg("muted", line), 0, 0));
    }
    const hint = this.tabbed()
      ? "Type to search. Tab switches target. Enter selects. Escape cancels."
      : "Type to search. Enter selects. Escape cancels.";
    this.headerContainer.addChild(new Text(theme.fg("muted", hint), 0, 0));
    this.headerContainer.addChild(new Spacer(1));
  }

  /** Moves to the next tab, dropping the search query so the new list starts unfiltered. */
  private cycleTab() {
    this.tabIndex = (this.tabIndex + 1) % this.tabs.length;
    this.searchInput.setValue("");
    this.selectedIndex = 0;
    this.filtered = this.items();
    this.updateHeader();
    this.updateList();
  }

  private filter(query: string) {
    this.filtered = query ? fuzzyFilter(this.items(), query, (item) => item.searchText) : this.items();
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
    if (this.tabbed() && this.params.keybindings.matches(keyData, "tui.input.tab")) {
      this.cycleTab();
      return;
    }

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
  /** Run mode: custom TUI components need "tui"; other dialog-capable modes degrade to select. */
  mode: string;
  ui: {
    custom<T>(factory: (tui: unknown, theme: Theme, keybindings: Keybindings, done: (value: T) => void) => unknown): Promise<T | undefined>;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export async function pickFromList<V>(ctx: CustomUiHost, params: SelectSource<V>): Promise<SelectItem<V> | undefined> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<SelectItem<V> | undefined>(
      (_tui, theme, keybindings, done) => new SearchableSelectList<V>({ ...params, theme, keybindings, done }),
    );
  }
  // Degrade to the plain select dialog, which RPC clients answer over the
  // extension-UI sub-protocol. Header lines fold into the title; the current
  // choice is tagged since the check-mark rendering is TUI-only. There is no
  // Tab key to press here, so each other tab becomes a "Switch to …" row that
  // re-opens the dialog on that tab.
  const tabs = normalizeTabs(params);
  let index = 0;
  for (;;) {
    const tab = tabs[index]!;
    const others = tabs.filter((_, at) => at !== index);
    const title = [params.title, ...(params.headerLines ?? []), ...(tab.headerLines ?? [])].join("\n");
    const labels = [
      ...tab.items.map((item) => (item.current ? `${item.label} (current)` : item.label)),
      ...others.map((other) => `Switch to ${other.label}…`),
    ];
    const picked = await ctx.ui.select(title, labels);
    if (picked === undefined) return undefined;
    const at = labels.indexOf(picked);
    if (at < 0) return undefined;
    if (at < tab.items.length) return tab.items[at];
    index = tabs.indexOf(others[at - tab.items.length]!);
  }
}
