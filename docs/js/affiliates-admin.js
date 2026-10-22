// Owner-only affiliate administration (/admin/affiliates).
//
// Nothing here is an authorization boundary. The page asks the same question
// the dashboard's licence controls ask — owner_licence_status — only to decide
// what to draw; every read and write is a database function that checks the
// owner again itself (owner_affiliates, owner_save_affiliate), and the tables
// behind them grant nothing to any browser role. For anyone else this page
// stays empty: no list is requested and no form is shown.

const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SITE_URL = "https://wavread.com";

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const affiliateLink = (code) => `${SITE_URL}/?from=aff-${code}`;

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
      `${affiliate.refunds} · ${money(affiliate.refunded_cents)}`,
    ];
  });
}

// Payable commission by month, newest month first, across every affiliate.
function monthRows(affiliates) {
  return affiliates
    .flatMap((affiliate) => (affiliate.months || []).map((month) => ({ ...month, code: affiliate.code, name: affiliate.name })))
    .sort((a, b) => b.month.localeCompare(a.month) || a.code.localeCompare(b.code))
    .map((month) => [month.month, `${month.name} (${month.code})`, month.sales, money(month.gross_cents), money(month.commission_cents)]);
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
  let editing = null;

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

  const render = async () => {
    const { data, error } = await client.rpc("owner_affiliates");
    const list = document.querySelector("#affiliate-list");
    const months = document.querySelector("#affiliate-months");
    list.replaceChildren();
    months.replaceChildren();
    if (error || !Array.isArray(data)) {
      setStatus(listStatus, "Affiliates could not be loaded. Refresh this page.", "error");
      return;
    }
    document.querySelector("#affiliate-empty").hidden = data.length > 0;
    if (data.length) {
      list.append(buildTable(
        ["Affiliate", "Link", "Rate", "Status", "Sales", "Pending (under 30 days)", "Payable", "Refunds"],
        affiliateRows(data, { copy, edit: startEdit, setActive }),
      ));
    }
    const payable = monthRows(data);
    document.querySelector("#affiliate-months-empty").hidden = payable.length > 0;
    if (payable.length) {
      months.append(buildTable(["Month", "Affiliate", "Sales", "Gross", "Commission"], payable));
    }
  };

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

  showState("admin-content");
  resetForm();
  submit.disabled = false;
  await render();
}

createAdminClient()
  .catch(() => null)
  .then(initializeAffiliateAdmin)
  .catch(() => showState("unavailable-state"));
