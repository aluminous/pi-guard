import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addSessionGuidance, type ClassifierState } from "../src/classifier.ts";
import { GuardApprovalDialog, type GuardApprovalAnswer } from "../src/tui/approval-dialog.ts";

const theme = { fg: (_name: string, text: string) => text };

/** Maps sentinel strings to select keybinding ids so tests can drive the dialog. */
const keybindings = {
  matches(keyData: string, keyId: string): boolean {
    return (
      (keyId === "tui.select.up" && keyData === "<up>") ||
      (keyId === "tui.select.down" && keyData === "<down>") ||
      (keyId === "tui.select.confirm" && keyData === "<enter>") ||
      (keyId === "tui.select.cancel" && keyData === "<esc>")
    );
  },
};

function openDialog(): { dialog: GuardApprovalDialog; answers: GuardApprovalAnswer[] } {
  const answers: GuardApprovalAnswer[] = [];
  const dialog = new GuardApprovalDialog({
    title: "Guard reviewer asks for approval",
    message: "Deploy to staging?",
    theme,
    keybindings,
    done: (answer) => answers.push(answer),
  });
  dialog.focused = true;
  return { dialog, answers };
}

describe("GuardApprovalDialog", () => {
  it("selects plain allow and deny options", () => {
    const allow = openDialog();
    allow.dialog.handleInput("<enter>");
    assert.deepEqual(allow.answers, [{ approved: true }]);

    const deny = openDialog();
    deny.dialog.handleInput("<down>");
    deny.dialog.handleInput("<down>");
    deny.dialog.handleInput("<enter>");
    assert.deepEqual(deny.answers, [{ approved: false }]);
  });

  it("escape denies without a comment", () => {
    const { dialog, answers } = openDialog();
    dialog.handleInput("<esc>");
    assert.deepEqual(answers, [{ approved: false }]);
  });

  it("collects a comment for allow-with-comment", () => {
    const { dialog, answers } = openDialog();
    dialog.handleInput("<down>");
    dialog.handleInput("<enter>");
    assert.equal(answers.length, 0);
    for (const ch of "ok today") dialog.handleInput(ch);
    dialog.handleInput("\r");
    assert.deepEqual(answers, [{ approved: true, comment: "ok today" }]);
  });

  it("escape during comment entry returns to the options instead of resolving", () => {
    const { dialog, answers } = openDialog();
    dialog.handleInput("<down>");
    dialog.handleInput("<enter>");
    dialog.handleInput("<esc>");
    assert.equal(answers.length, 0);
    dialog.handleInput("<esc>");
    assert.deepEqual(answers, [{ approved: false }]);
  });

  it("submits an empty comment as no comment", () => {
    const { dialog, answers } = openDialog();
    dialog.handleInput("<down>");
    dialog.handleInput("<enter>");
    dialog.handleInput("\r");
    assert.deepEqual(answers, [{ approved: true }]);
  });
});

describe("addSessionGuidance", () => {
  it("formats entries and keeps only the most recent ones", () => {
    const state: ClassifierState = {};
    addSessionGuidance(state, "allowed", "bash", "npm run deploy", "staging deploys are fine");
    assert.equal(state.sessionGuidance?.length, 1);
    assert.match(state.sessionGuidance![0]!, /^User allowed bash \(npm run deploy\) with comment: staging deploys are fine$/);

    for (let i = 0; i < 20; i++) addSessionGuidance(state, "denied", "write", `file-${i}`, `no ${i}`);
    assert.equal(state.sessionGuidance?.length, 12);
    assert.match(state.sessionGuidance!.at(-1)!, /no 19/);
  });
});
