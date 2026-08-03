import { Container, Input, Spacer, Text } from "@earendil-works/pi-tui";
import type { Keybindings, Theme } from "./select-list.ts";

export interface GuardApprovalAnswer {
  approved: boolean;
  /** Optional user comment, recorded as classifier session guidance. */
  comment?: string;
}

interface ApprovalOption {
  label: string;
  approved: boolean;
  withComment: boolean;
  description: string;
}

export const APPROVAL_OPTIONS: ApprovalOption[] = [
  { label: "Allow", approved: true, withComment: false, description: "Run this call" },
  { label: "Allow with comment…", approved: true, withComment: true, description: "Run it and tell the guard why, for the rest of the session" },
  { label: "Deny", approved: false, withComment: false, description: "Block this call" },
  { label: "Deny with comment…", approved: false, withComment: true, description: "Block it and tell the guard (and the agent) why" },
];

/**
 * Four-way approval dialog for guard prompts: Allow / Allow with comment /
 * Deny / Deny with comment. Comments become session guidance for the
 * classifier. Escape denies without comment (matching the previous
 * confirm-dialog semantics); escape while typing a comment returns to the
 * options instead.
 */
export class GuardApprovalDialog extends Container {
  private commentInput = new Input();
  private dynamic = new Container();
  private selectedIndex = 0;
  private enteringComment = false;
  private _focused = false;
  private theme: Theme;
  private keybindings: Keybindings;
  private done: (answer: GuardApprovalAnswer) => void;

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.commentInput.focused = value && this.enteringComment;
  }

  constructor(params: { title: string; message: string; theme: Theme; keybindings: Keybindings; done: (answer: GuardApprovalAnswer) => void }) {
    super();
    this.theme = params.theme;
    this.keybindings = params.keybindings;
    this.done = params.done;
    this.addChild(new Text(params.theme.fg("accent", params.title), 0, 0));
    this.addChild(new Text(params.message, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.dynamic);
    this.commentInput.onSubmit = () => this.submitComment();
    this.update();
  }

  private submitComment(): void {
    const option = APPROVAL_OPTIONS[this.selectedIndex];
    if (!option) return;
    const comment = this.commentInput.getValue().trim();
    this.done(comment ? { approved: option.approved, comment } : { approved: option.approved });
  }

  private choose(): void {
    const option = APPROVAL_OPTIONS[this.selectedIndex];
    if (!option) return;
    if (!option.withComment) {
      this.done({ approved: option.approved });
      return;
    }
    this.enteringComment = true;
    this.commentInput.focused = this._focused;
    this.update();
  }

  private update(): void {
    const theme = this.theme;
    this.dynamic.clear();
    if (this.enteringComment) {
      const option = APPROVAL_OPTIONS[this.selectedIndex];
      this.dynamic.addChild(new Text(`${option?.approved ? "Allowing" : "Denying"} with a comment for the guard:`, 0, 0));
      this.dynamic.addChild(this.commentInput);
      this.dynamic.addChild(new Spacer(1));
      this.dynamic.addChild(new Text(theme.fg("muted", "Enter submits. Escape goes back."), 0, 0));
      return;
    }
    for (let i = 0; i < APPROVAL_OPTIONS.length; i++) {
      const option = APPROVAL_OPTIONS[i];
      if (!option) continue;
      const selected = i === this.selectedIndex;
      const prefix = selected ? theme.fg("accent", "→ ") : "  ";
      const label = selected ? theme.fg("accent", option.label) : option.label;
      this.dynamic.addChild(new Text(`${prefix}${label}`, 0, 0));
    }
    const current = APPROVAL_OPTIONS[this.selectedIndex];
    this.dynamic.addChild(new Spacer(1));
    this.dynamic.addChild(new Text(theme.fg("muted", `  ${current?.description ?? ""}. Enter selects. Escape denies.`), 0, 0));
  }

  handleInput(keyData: string): void {
    if (this.enteringComment) {
      if (this.keybindings.matches(keyData, "tui.select.cancel")) {
        this.enteringComment = false;
        this.commentInput.focused = false;
        this.update();
        return;
      }
      this.commentInput.handleInput(keyData);
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? APPROVAL_OPTIONS.length - 1 : this.selectedIndex - 1;
      this.update();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === APPROVAL_OPTIONS.length - 1 ? 0 : this.selectedIndex + 1;
      this.update();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.confirm")) {
      this.choose();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      this.done({ approved: false });
    }
  }
}
