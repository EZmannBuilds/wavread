// The article editor (/account/articles/new and /account/articles/edit?id=).
//
// Markdown on the left, the preview on the right, redrawn 300 ms after the
// last keystroke. Below them, what the article still needs before review
// (the same rules the submit function applies, from article-rules.js) and the
// house style notes, which advise and never block.
//
// A writer can save a draft and submit it for review. There is no publish
// button and no call here that publishes: review happens elsewhere, by a
// person, and publishing is a separate owner step after approval. Once an
// article is submitted the editor locks until the reviewer sends it back.

import { STATUS_LABELS, callFunction, createAccountClient, fmtDate, setStatus, showState, signedInAccount, sitePath } from "./account-client.js";
import { AUTHOR_EDITABLE, SUBMISSION_COLUMNS, isSubmissionId, normalizeDraft, submissionProblems, voiceWarnings } from "./article-rules.js";
import { renderPreview } from "./markdown-preview.js";

export const PREVIEW_DELAY_MS = 300;
const STATES = ["loading-state", "setup-state", "signed-out-state", "unauthorized-state", "missing-state", "editor-content"];

// What each toolbar button does to the text. Pure, so it is tested without a
// page: answers the new value and the selection to leave behind.
export function applyFormat(value, start, end, kind) {
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  const wrap = (mark, placeholder) => {
    const inner = selected || placeholder;
    return { value: `${before}${mark}${inner}${mark}${after}`, start: start + mark.length, end: start + mark.length + inner.length };
  };
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  // Block markers belong at the start of a line, with a blank line before
  // them unless they are the first thing in the article.
  const opening = (text) => (text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n");
  switch (kind) {
    case "bold": return wrap("**", "bold text");
    case "italic": return wrap("*", "italic text");
    case "heading": {
      const line = value.slice(lineStart);
      if (/^#{2,4}\s/.test(line)) return { value, start, end };
      const prefix = "## ";
      if (selected) {
        const head = value.slice(0, start);
        const lead = opening(head);
        const text = `${head}${lead}${prefix}${selected.replace(/\n+/g, " ")}\n\n${after.replace(/^\n+/, "")}`;
        const at = head.length + lead.length + prefix.length;
        return { value: text, start: at, end: at + selected.replace(/\n+/g, " ").length };
      }
      return { value: `${value.slice(0, lineStart)}${prefix}${value.slice(lineStart)}`, start: start + prefix.length, end: end + prefix.length };
    }
    case "link": {
      const label = selected || "link text";
      const url = "https://";
      const text = `${before}[${label}](${url})${after}`;
      const at = before.length + label.length + 3;
      return { value: text, start: at, end: at + url.length };
    }
    case "list": {
      const from = lineStart;
      const block = value.slice(from, end) || "";
      const lines = (block || "list item").split("\n").map((line) => (/^[-*]\s/.test(line) ? line : `- ${line}`));
      const text = `${value.slice(0, from)}${lines.join("\n")}${value.slice(end)}`;
      return { value: text, start: from, end: from + lines.join("\n").length };
    }
    case "code": {
      const head = before;
      const lead = opening(head);
      const inner = selected || "code";
      const gap = after === "" || after.startsWith("\n") ? "" : "\n";
      const text = `${head}${lead}\`\`\`\n${inner}\n\`\`\`\n${gap}${after}`;
      const at = head.length + lead.length + 4;
      return { value: text, start: at, end: at + inner.length };
    }
    default: return { value, start, end };
  }
}

const STATUS_DETAIL = {
  draft: (s) => (s.submitted_at
    ? "Back with you after review. Make the changes the notes ask for, then submit it again."
    : "Only you can see this draft. Submit it when it is ready for a person to review."),
  pending: (s) => `Waiting for review since ${fmtDate(s.submitted_at, true)}. It cannot be changed until the reviewer replies.`,
  needs_changes: () => "The reviewer asked for changes. Edit the article below, then submit it again.",
  approved: () => "Approved. WavRead publishes it from here; there is nothing more for you to do.",
  rejected: () => "Not accepted. The reviewer's notes say why.",
  published: (s) => `Published${s.published_at ? ` on ${fmtDate(s.published_at, true)}` : ""}. It appears in WavRead's articles once the site is next built.`,
};

function initialize(page) {
  let supabase = null;
  let config = null;
  let current = null;
  let dirty = false;
  let voiceAcknowledged = false;
  let timer = null;

  const form = page.querySelector("#editor-form");
  const title = page.querySelector("#article-title");
  const summary = page.querySelector("#article-summary");
  const body = page.querySelector("#article-body");
  const lanes = [...page.querySelectorAll('input[name="lanes"]')];
  const preview = page.querySelector("#article-preview");
  const status = page.querySelector("#editor-status");
  const saveButton = page.querySelector("#save-button");
  const submitButton = page.querySelector("#submit-button");
  const toolbar = [...page.querySelectorAll(".editor-toolbar button")];
  const count = page.querySelector("#body-count");

  const fields = () => ({
    title: title.value,
    summary: summary.value,
    lanes: lanes.filter((box) => box.checked).map((box) => box.value),
    body_markdown: body.value,
  });

  const editable = () => !current || AUTHOR_EDITABLE.has(current.status);

  function list(id, items) {
    const element = page.querySelector(id);
    element.replaceChildren(...items.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }

  function check() {
    const values = fields();
    if (values.body_markdown.trim()) renderPreview(preview, values.body_markdown);
    else {
      const empty = document.createElement("p");
      empty.className = "preview-empty";
      empty.textContent = "Your article appears here as you write it.";
      preview.replaceChildren(empty);
    }
    const length = [...values.body_markdown].length;
    count.textContent = `${length.toLocaleString("en-US")} character${length === 1 ? "" : "s"}`;
    const problems = submissionProblems(values);
    const voice = voiceWarnings(values).map((warning) => warning.message);
    list("#problems-list", problems);
    list("#voice-list", voice);
    page.querySelector("#checks-problems").hidden = !problems.length || !editable();
    page.querySelector("#checks-voice").hidden = !voice.length || !editable();
    return { problems, voice };
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, PREVIEW_DELAY_MS);
  };

  function renderStatus() {
    const panel = page.querySelector("#status-panel");
    panel.hidden = !current;
    if (!current) return;
    panel.dataset.status = current.status;
    page.querySelector("#status-chip").textContent = STATUS_LABELS[current.status] || current.status;
    page.querySelector("#status-detail").textContent = (STATUS_DETAIL[current.status] || (() => ""))(current);
    const notes = page.querySelector("#reviewer-notes");
    notes.hidden = !current.reviewer_notes;
    notes.textContent = current.reviewer_notes ? `Reviewer's notes: ${current.reviewer_notes}` : "";
    const locked = !editable();
    for (const field of [title, summary, body]) field.readOnly = locked;
    for (const box of lanes) box.disabled = locked;
    for (const button of toolbar) button.disabled = locked;
    saveButton.disabled = locked;
    submitButton.disabled = locked;
    saveButton.hidden = locked;
    submitButton.hidden = locked;
  }

  function fill(submission) {
    title.value = submission.title || "";
    summary.value = submission.summary || "";
    body.value = submission.body_markdown || "";
    for (const box of lanes) box.checked = (submission.lanes || []).includes(box.value);
  }

  const busy = (on) => {
    saveButton.disabled = on || !editable();
    submitButton.disabled = on || !editable();
  };

  async function save() {
    const { fields: clean, problems } = normalizeDraft(fields());
    if (problems.length) {
      setStatus(status, problems[0], "error");
      return null;
    }
    busy(true);
    setStatus(status, "Saving your draft…");
    const result = await callFunction(supabase, config, "article-submission-save", current ? { id: current.id, ...clean } : clean);
    busy(false);
    if (!result.ok) {
      setStatus(status, result.data?.error || (result.status === 0
        ? "Could not reach the editor service. Check your connection; your text is still here."
        : "The draft could not be saved. Your text is still here; try again shortly."), "error");
      return null;
    }
    const first = !current;
    current = result.data.submission;
    dirty = false;
    if (first) {
      // Reloading now reopens this draft rather than starting another.
      history.replaceState(null, "", sitePath(`/account/articles/edit?id=${encodeURIComponent(current.id)}`));
      page.querySelector("#editor-title").textContent = "Edit your article";
    }
    renderStatus();
    check();
    setStatus(status, `Draft saved at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`, "success");
    return current;
  }

  async function submitForReview() {
    const { problems, voice } = check();
    if (problems.length) {
      setStatus(status, "A few things are needed before review. They are listed above the buttons.", "error");
      return;
    }
    // House style notes warn once, then step aside.
    if (voice.length && !voiceAcknowledged) {
      voiceAcknowledged = true;
      submitButton.textContent = "Submit anyway";
      setStatus(status, `${voice.length === 1 ? "There is 1 house style note" : `There are ${voice.length} house style notes`} above. Fix them, or press Submit anyway.`, "error");
      return;
    }
    const saved = await save();
    if (!saved) return;
    busy(true);
    setStatus(status, "Submitting for review…");
    const result = await callFunction(supabase, config, "article-submission-submit", { id: saved.id });
    busy(false);
    if (!result.ok) {
      const listed = result.data?.problems?.length ? ` ${result.data.problems.join(" ")}` : "";
      setStatus(status, `${result.data?.error || "The article could not be submitted. Try again shortly."}${listed}`, "error");
      return;
    }
    current = result.data.submission;
    dirty = false;
    renderStatus();
    check();
    setStatus(status, "Submitted. A person reviews it, and their reply appears here and on your account page.", "success");
  }

  function format(kind) {
    if (!editable()) return;
    const next = applyFormat(body.value, body.selectionStart, body.selectionEnd, kind);
    body.value = next.value;
    body.focus();
    body.setSelectionRange(next.start, next.end);
    dirty = true;
    voiceAcknowledged = false;
    submitButton.textContent = "Submit for review";
    schedule();
  }

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("input", () => {
    dirty = true;
    voiceAcknowledged = false;
    submitButton.textContent = "Submit for review";
    schedule();
  });
  for (const button of toolbar) button.addEventListener("click", () => format(button.dataset.insert));
  body.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "b" || key === "i") {
      event.preventDefault();
      format(key === "b" ? "bold" : "italic");
    }
  });
  saveButton.addEventListener("click", () => save());
  submitButton.addEventListener("click", () => submitForReview());
  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  (async () => {
    try {
      const ctx = await createAccountClient();
      supabase = ctx?.supabase ?? null;
      config = ctx?.config ?? null;
    } catch {
      supabase = null;
    }
    if (!supabase) return showState(STATES, "setup-state");
    const signOut = async () => {
      await supabase.auth.signOut();
      location.replace(sitePath("/signin"));
    };
    page.querySelector("#unauthorized-signout")?.addEventListener("click", signOut);
    const result = await signedInAccount(supabase, "tester_id, status");
    if (result.signedOut) {
      page.querySelector("#signin-link").href = `${sitePath("/signin")}?next=/account/articles/new`;
      return showState(STATES, "signed-out-state");
    }
    const signoutButton = page.querySelector("#signout-button");
    signoutButton.hidden = false;
    signoutButton.addEventListener("click", signOut);
    if (result.problem) {
      page.querySelector("#unauthorized-message").textContent = result.problem;
      return showState(STATES, "unauthorized-state");
    }

    const id = new URLSearchParams(location.search).get("id");
    if (id) {
      if (!isSubmissionId(id)) return showState(STATES, "missing-state");
      const { data, error } = await supabase.from("article_submissions").select(SUBMISSION_COLUMNS).eq("id", id).maybeSingle();
      if (error) return showState(STATES, "setup-state");
      if (!data) return showState(STATES, "missing-state");
      current = data;
      fill(current);
    }
    showState(STATES, "editor-content");
    renderStatus();
    check();
    if (editable()) {
      saveButton.disabled = false;
      submitButton.disabled = false;
    }
  })();
}

const editorPage = globalThis.document?.querySelector("#editor-content");
if (editorPage) initialize(document);
