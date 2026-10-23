// Owner-only affiliate administration (/admin/affiliates).
//
// Nothing here is an authorization boundary. The page asks the same question
// the dashboard's licence controls ask — owner_licence_status — only to decide
// what to draw; every read and write is a database function that checks the
// owner again itself (owner_affiliates, owner_save_affiliate,
// owner_affiliate_payable_by_month, owner_mark_month_paid), and the tables
// behind them grant nothing to any browser role. For anyone else this page
// stays empty: no list is requested and no form is shown.

const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SITE_URL = "https://wavread.com";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
const money = (cents) => `$${dollars(cents)}`;
const affiliateLink = (code) => `${SITE_URL}/?from=aff-${code}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
// The database sends a month as its first day ("2026-08-01") and times in ISO
// 8601; the page shows both in UTC, the zone the months are cut in.
const monthName = (day) => `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const utcDay = (timestamp) => (timestamp ? new Date(timestamp).toISOString().slice(0, 10) : "");

async function loadConfiguration() {
  if (LOCAL_HOSTS.has(location.hostname)) return window.WAVREAD_BETA_CONFIG;
  try {
    const response = await fetch("/api/beta-config", { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const config = await response.json();
    return config.configured ? config : null;
  } catch {
    return null;
  }
}

// The dashboard's session, under the dashboard's storage key: an owner signed
// in there is signed in here.
async function createAdminClient() {
  const config = await loadConfiguration();
  if (!config?.url || !config?.publishableKey) return null;
  const { createClient } = await import(SUPABASE_MODULE);
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "wavread-beta-session" }
  });
}

function setStatus(element, message, state = "") {
  element.textContent = message;
  element.dataset.state = state;
}

function showState(id) {
  for (const state of ["loading-state", "unavailable-state", "admin-content"]) {
    document.querySelector(`#${state}`).hidden = state !== id;
  }
}

// The database says why a save was refused in words meant for this page; the
// codes that need a different sentence get one.
function saveError(error) {
  if (error?.code === "23505") return "That code is already taken. Codes are permanent, so choose another.";
  if (error?.code === "42501") return "This sign-in no longer has owner access. Sign in again from the dashboard.";
  if (error?.code === "22023" || error?.code === "P0002") return error.message;
  return "The affiliate could not be saved. Check your connection and try again.";
}

// mark_month_paid explains each refusal (too early, nothing payable, already
// paid, the amount moved) in words meant for this page.
function payoutError(error) {
  if (error?.code === "42501") return "This sign-in no longer has owner access. Sign in again from the dashboard.";
  if (["22023", "P0002", "55000", "23505"].includes(error?.code)) return error.message;
  return "The payout could not be recorded. Reload the page and check this month before trying again.";
}

function buildTable(headers, rows) {
  const table = document.createElement("table");
  table.className = "nowrap";
  const head = table.createTHead().insertRow();
  headers.forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.append(th);
  });
  const body = table.createTBody();
  rows.forEach((cells) => {
    const row = body.insertRow();
    cells.forEach((cell) => {
      const td = row.insertCell();
      if (typeof cell === "object" && cell !== null) td.append(cell);
      else td.textContent = String(cell);
    });
  });
  return table;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, onClick) {
  const node = element("button", label, "btn tiny");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// One row per affiliate, in the order the database gives (active first).
function affiliateRows(affiliates, actions) {
  return affiliates.map((affiliate) => {
    // The controls sit under the name, so they stay in view when the figures
    // to the right scroll.
    const who = element("span");
    who.append(
      element("strong", affiliate.name), element("br"),
      element("span", `${affiliate.code} · ${affiliate.email}`, "table-status"), element("br"),
      button("Edit", () => actions.edit(affiliate)),
      button(affiliate.active ? "Deactivate" : "Reactivate", () => actions.setActive(affiliate, !affiliate.active)),
    );

    const link = element("span");
    const url = affiliateLink(affiliate.code);
    link.append(element("code", url), element("br"), button("Copy link", () => actions.copy(url)));

    const status = element("span", affiliate.active ? "Active" : "Inactive", "table-status");
    return [
      who,
      link,
      `${Number(affiliate.commission_pct)}%`,
      status,
      `${affiliate.sales} · ${money(affiliate.gross_cents)}`,
      `${affiliate.pending_sales} · ${money(affiliate.pending_commission_cents)}`,
      money(affiliate.payable_commission_cents),
      money(affiliate.paid_commission_cents),
      `${affiliate.refunds} · ${money(affiliate.refunded_cents)}`,
    ];
  });
}

// === payouts ================================================================

// A month's standing, in the words the page and the CSV share: its status
// first, then needs review and clawback needed when they apply.
const MONTH_STATUS = { paid: "paid", on_hold: "on hold", payable: "payable", nothing_payable: "nothing payable" };
const SALE_STATUS = {
  payable: "payable", pending: "on hold", paid: "paid", clawback: "clawback needed",
  needs_review: "needs review", refunded: "refunded", excluded: "not charged",
};

function monthStatuses(month) {
  const words = [MONTH_STATUS[month.status] ?? String(month.status)];
  if (month.needs_review_sales > 0) words.push("needs review");
  if (month.clawback_sales > 0) words.push("clawback needed");
  return words;
}

function monthStatusText(month) {
  const parts = [
    month.status === "paid" ? `Paid ${utcDay(month.paid_at)} via ${month.method_note}`
      : month.status === "on_hold" ? `On hold until ${utcDay(month.hold_ends_at)}`
      : month.status === "payable" ? "Payable"
      : "Nothing payable",
  ];
  if (month.needs_review_sales > 0) parts.push(`Needs review: ${plural(month.needs_review_sales, "sale")}`);
  if (month.clawback_sales > 0) parts.push(`Clawback needed: ${money(month.clawback_cents)} on ${plural(month.clawback_sales, "refunded sale")}`);
  return parts.join(" · ");
}

// One table per affiliate, months newest first, in the order the database
// gives. Only a payable month offers Mark paid; the database checks again.
function payoutTables(months, actions) {
  const groups = new Map();
  for (const month of months) {
    if (!groups.has(month.affiliate_code)) groups.set(month.affiliate_code, []);
    groups.get(month.affiliate_code).push(month);
  }
  return [...groups.values()].flatMap((group) => [
    element("h3", `${group[0].affiliate_name} (${group[0].affiliate_code})`),
    buildTable(["Month", "Sales", "Amount", "Status", "Action"], group.map((month) => [
      month.period_month.slice(0, 7),
      month.sales_count,
      money(month.amount_cents),
      monthStatusText(month),
      month.status === "payable" ? button("Mark paid", () => actions.markPaid(month)) : "",
    ])),
  ]);
}

// A spreadsheet runs a cell that starts with = + - or @ (or a tab or carriage
// return ahead of one) as a formula, so such a cell gets a leading quote and is
// read as text. Then RFC 4180: a cell holding a comma, quote or line break is
// quoted, with its quotes doubled.
function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// The byte-order mark tells a spreadsheet the file is UTF-8.
function csvText(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// One row per affiliate per month.
function payoutCsv(months) {
  return csvText([
    ["affiliate code", "period month", "sales count", "amount (dollars)", "status", "paid date", "method note", "needs review sales", "clawback (dollars)"],
    ...months.map((month) => [
      month.affiliate_code,
      month.period_month.slice(0, 7),
      month.sales_count,
      dollars(month.amount_cents),
      monthStatuses(month).join("; "),
      month.status === "paid" ? utcDay(month.paid_at) : "",
      month.method_note ?? "",
      month.needs_review_sales,
      dollars(month.clawback_cents),
    ]),
  ]);
}

// One row per credited sale. Commission is what the month counts for the sale
// (the frozen figure once paid); a refund whose amount was never recorded
// reads "unknown".
function payoutSalesCsv(months) {
  return csvText([
    ["affiliate code", "period month", "purchase date", "session id suffix", "gross (dollars)", "commission (dollars)", "status", "refunded (dollars)"],
    ...months.flatMap((month) => (month.sales || []).map((sale) => [
      month.affiliate_code,
      month.period_month.slice(0, 7),
      sale.purchased_on,
      sale.session_suffix,
      dollars(sale.gross_cents),
      dollars(sale.commission_cents),
      SALE_STATUS[sale.state] ?? String(sale.state),
      !sale.has_refund ? "" : sale.amount_refunded_cents === null || sale.amount_refunded_cents === undefined ? "unknown" : dollars(sale.amount_refunded_cents),
    ])),
  ]);
}

// Built in the page from what it already shows: a download asks the database
// for nothing new.
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = element("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initializeAffiliateAdmin(client) {
  // Signed out, not configured, or not the owner: the same empty page, and no
  // affiliate data is ever requested.
  const user = client ? await client.auth.getUser() : null;
  if (!user || user.error || !user.data?.user) return showState("unavailable-state");
  const permission = await client.rpc("owner_licence_status");
  if (permission.error || permission.data !== true) return showState("unavailable-state");

  const form = document.querySelector("#affiliate-form");
  const submit = form.querySelector("button[type=submit]");
  const cancel = document.querySelector("#affiliate-cancel");
  const title = document.querySelector("#affiliate-form-title");
  const code = document.querySelector("#affiliate-code");
  const name = document.querySelector("#affiliate-name");
  const email = document.querySelector("#affiliate-email");
  const pct = document.querySelector("#affiliate-pct");
  const active = document.querySelector("#affiliate-active");
  const activeField = document.querySelector("#affiliate-active-field");
  const preview = document.querySelector("#affiliate-code-preview");
  const formStatus = document.querySelector("#affiliate-form-status");
  const listStatus = document.querySelector("#affiliate-list-status");
  const payoutForm = document.querySelector("#payout-form");
  const payoutTitle = document.querySelector("#payout-form-title");
  const payoutSummary = document.querySelector("#payout-summary");
  const payoutNote = document.querySelector("#payout-note");
  const payoutConfirm = document.querySelector("#payout-confirm");
  const payoutFormStatus = document.querySelector("#payout-form-status");
  const payoutsStatus = document.querySelector("#payouts-status");
  const payoutsCsvButton = document.querySelector("#payouts-csv");
  const salesCsvButton = document.querySelector("#payout-sales-csv");
  let editing = null;
  // The months last loaded, which the CSV buttons export, and the one being
  // marked paid.
  let months = [];
  let marking = null;

  const previewLink = () => { preview.textContent = affiliateLink(code.value.trim().toLowerCase() || "…"); };
  code.addEventListener("input", previewLink);

  const resetForm = () => {
    editing = null;
    form.reset();
    code.readOnly = false;
    activeField.hidden = true;
    cancel.hidden = true;
    title.textContent = "Add an affiliate";
    submit.textContent = "Add affiliate";
    previewLink();
  };

  const startEdit = (affiliate) => {
    editing = affiliate.code;
    code.value = affiliate.code;
    code.readOnly = true;
    name.value = affiliate.name;
    email.value = affiliate.email;
    pct.value = String(Number(affiliate.commission_pct));
    active.checked = affiliate.active;
    activeField.hidden = false;
    cancel.hidden = false;
    title.textContent = `Edit ${affiliate.code}`;
    submit.textContent = "Save changes";
    setStatus(formStatus, "");
    previewLink();
    form.scrollIntoView?.({ block: "start" });
  };

  const save = (operation, fields) => client.rpc("owner_save_affiliate", {
    operation,
    target_code: fields.code,
    target_name: fields.name,
    target_email: fields.email,
    target_pct: fields.pct,
    target_active: fields.active,
  });

  const copy = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus(listStatus, `Copied ${url}`, "success");
    } catch {
      setStatus(listStatus, `Copy was blocked. Select the link and copy it: ${url}`, "error");
    }
  };

  const renderAffiliates = async () => {
    const { data, error } = await client.rpc("owner_affiliates");
    const list = document.querySelector("#affiliate-list");
    list.replaceChildren();
    if (error || !Array.isArray(data)) {
      setStatus(listStatus, "Affiliates could not be loaded. Refresh this page.", "error");
      return;
    }
    document.querySelector("#affiliate-empty").hidden = data.length > 0;
    if (data.length) {
      list.append(buildTable(
        ["Affiliate", "Link", "Rate", "Status", "Sales", "Pending (under 30 days)", "Payable", "Paid out", "Refunds"],
        affiliateRows(data, { copy, edit: startEdit, setActive }),
      ));
    }
  };

  const stopMarking = () => {
    marking = null;
    payoutForm.hidden = true;
    payoutNote.value = "";
  };

  // The confirm step: Mark paid only opens this form, which says exactly what
  // will be recorded. Nothing is written until it is submitted with a note.
  const startMarking = (month) => {
    marking = month;
    payoutTitle.textContent = `Mark ${monthName(month.period_month)} paid for ${month.affiliate_code}`;
    payoutSummary.textContent = `${month.affiliate_name} (${month.affiliate_code}) is owed ${money(month.amount_cents)} for `
      + `${plural(month.sales_count, "sale")} made in ${monthName(month.period_month)}, at ${Number(month.commission_pct)}%. `
      + "Pay them by hand first. Confirming records the payment and freezes these sales at this amount; it cannot be undone from this page.";
    payoutConfirm.textContent = `Confirm: I have paid ${money(month.amount_cents)}`;
    payoutNote.value = "";
    setStatus(payoutFormStatus, "");
    payoutForm.hidden = false;
    payoutForm.scrollIntoView?.({ block: "start" });
    payoutNote.focus?.();
  };

  const renderPayouts = async () => {
    const { data, error } = await client.rpc("owner_affiliate_payable_by_month");
    const list = document.querySelector("#payouts");
    list.replaceChildren();
    months = !error && Array.isArray(data) ? data : [];
    payoutsCsvButton.disabled = salesCsvButton.disabled = months.length === 0;
    if (error || !Array.isArray(data)) {
      setStatus(payoutsStatus, "Payouts could not be loaded. Refresh this page.", "error");
      return;
    }
    document.querySelector("#payouts-empty").hidden = months.length > 0;
    list.append(...payoutTables(months, { markPaid: startMarking }));
  };

  const render = () => Promise.all([renderAffiliates(), renderPayouts()]);

  async function setActive(affiliate, makeActive) {
    setStatus(listStatus, `${makeActive ? "Reactivating" : "Deactivating"} ${affiliate.code}…`);
    const { error } = await save("update", {
      code: affiliate.code,
      name: affiliate.name,
      email: affiliate.email,
      pct: Number(affiliate.commission_pct),
      active: makeActive,
    });
    if (error) {
      setStatus(listStatus, saveError(error), "error");
      return;
    }
    setStatus(listStatus, `${affiliate.code} is ${makeActive ? "active" : "inactive"}.`, "success");
    if (editing === affiliate.code) resetForm();
    await render();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    setStatus(formStatus, editing ? "Saving…" : "Adding…");
    try {
      const { error } = await save(editing ? "update" : "create", {
        code: editing ?? code.value.trim().toLowerCase(),
        name: name.value.trim(),
        email: email.value.trim().toLowerCase(),
        pct: Number(pct.value),
        active: editing ? active.checked : true,
      });
      if (error) {
        setStatus(formStatus, saveError(error), "error");
        return;
      }
      const saved = editing ?? code.value.trim().toLowerCase();
      setStatus(formStatus, editing ? `Saved ${saved}.` : `Added ${saved}. Their link: ${affiliateLink(saved)}`, "success");
      resetForm();
      await render();
    } catch {
      setStatus(formStatus, saveError(null), "error");
    } finally {
      submit.disabled = false;
    }
  });
  cancel.addEventListener("click", () => {
    resetForm();
    setStatus(formStatus, "");
  });

  payoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!marking || payoutConfirm.disabled) return;
    const note = payoutNote.value.trim();
    if (!note) {
      setStatus(payoutFormStatus, "Say how you paid, for example PayPal or Zelle.", "error");
      return;
    }
    const month = marking;
    payoutConfirm.disabled = true;
    setStatus(payoutFormStatus, "Recording…");
    try {
      // The amount the owner was shown goes too: if a refund has moved it since
      // the page loaded, the database refuses rather than record a different sum.
      const { error } = await client.rpc("owner_mark_month_paid", {
        target_code: month.affiliate_code,
        target_month: month.period_month,
        target_note: note,
        expected_cents: month.amount_cents,
      });
      if (error) {
        setStatus(payoutFormStatus, payoutError(error), "error");
        return;
      }
      stopMarking();
      setStatus(payoutsStatus, `Recorded: ${monthName(month.period_month)} paid to ${month.affiliate_code}, ${money(month.amount_cents)} via ${note}.`, "success");
      await render();
    } catch {
      setStatus(payoutFormStatus, payoutError(null), "error");
    } finally {
      payoutConfirm.disabled = false;
    }
  });
  document.querySelector("#payout-cancel").addEventListener("click", () => {
    stopMarking();
    setStatus(payoutFormStatus, "");
  });

  const today = () => new Date().toISOString().slice(0, 10);
  payoutsCsvButton.addEventListener("click", () => download(`wavread-affiliate-payouts-${today()}.csv`, payoutCsv(months)));
  salesCsvButton.addEventListener("click", () => download(`wavread-affiliate-payout-sales-${today()}.csv`, payoutSalesCsv(months)));

  showState("admin-content");
  resetForm();
  stopMarking();
  submit.disabled = false;
  await render();
}

createAdminClient()
  .catch(() => null)
  .then(initializeAffiliateAdmin)
  .catch(() => showState("unavailable-state"));
