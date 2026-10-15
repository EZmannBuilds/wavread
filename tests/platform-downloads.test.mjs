import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// The catalog as it stands: Windows 1.5.6 (row 16) was published after Mac
// 1.5.6 (row 15), so it is the first row the dashboard reads. Whatever the
// browser says, the Mac button must never reach row 16.
const CATALOG = [
  { id: 16, version: "1.5.6", platform: "windows", file_name: "WavRead-1.5.6-Setup.exe", price_cents: 5000 },
  { id: 15, version: "1.5.6", platform: "macos", file_name: "WavRead-1.5.6.dmg", price_cents: 5000 },
  { id: 14, version: "1.5.4", platform: "macos", file_name: "WavRead-1.5.4.dmg", price_cents: 5000 },
];

const BROWSERS = {
  safariMac: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0 },
  chromeMac: { userAgentData: { platform: "macOS", mobile: false }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform: "MacIntel", maxTouchPoints: 0 },
  firefoxMac: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0", platform: "MacIntel", maxTouchPoints: 0 },
  edgeWindows: { userAgentData: { platform: "Windows", mobile: false }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", platform: "Win32", maxTouchPoints: 0 },
  firefoxWindows: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0", platform: "Win32", maxTouchPoints: 0 },
  iPhone: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 },
  // iPadOS Safari asks for the desktop site by default and calls itself a Mac.
  iPad: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 },
  android: { userAgentData: { platform: "Android", mobile: true }, userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", platform: "Linux armv81", maxTouchPoints: 5 },
  linux: { userAgentData: { platform: "Linux", mobile: false }, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform: "Linux x86_64", maxTouchPoints: 0 },
  chromebook: { userAgentData: { platform: "Chrome OS", mobile: false }, userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform: "Linux x86_64", maxTouchPoints: 0 },
  silent: {},
};

function element(tag) {
  return {
    tag, children: [], dataset: {}, hidden: true, disabled: false, className: "", textContent: "", listeners: {},
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

// The dashboard's own script, run in a page that has only what these buttons
// touch, with the network calls replaced by a record of which build they got.
async function dashboard(navigator) {
  const box = element("div");
  const note = element("p");
  const downloaded = [];
  const bought = [];
  const context = vm.createContext({
    navigator, Intl, URL, URLSearchParams, AbortSignal, downloaded, bought,
    location: { hostname: "wavread.com", origin: "https://wavread.com" },
    document: {
      createElement: element,
      querySelector: (selector) => ({ "#platform-downloads": box, "#platform-note": note })[selector] ?? null,
    },
  });
  const source = (await readFile("docs/js/beta-auth.js", "utf8")).replace("initializeSignIn();\ninitializeDashboard();", "");
  vm.runInContext(`${source}
downloadBuild = (build) => downloaded.push(build.id);
buyBuild = (build) => bought.push(build.id);`, context);
  const render = (builds, owned) => {
    context.builds = builds;
    context.has = (b) => owned.has(b.version);
    vm.runInContext("renderPlatformDownloads(builds, has, null)", context);
    return box.children.map((item) => ({
      platform: item.dataset.platform,
      detected: item.dataset.detected === "true",
      button: item.children[0],
      detail: item.children[1].textContent,
    }));
  };
  return { box, note, downloaded, bought, render, detect: (nav) => context.detectPlatform(nav) };
}

test("the browser's own platform is detected, and anything unsure is not guessed", async () => {
  const { detect } = await dashboard(undefined);
  const expected = {
    safariMac: "macos", chromeMac: "macos", firefoxMac: "macos",
    edgeWindows: "windows", firefoxWindows: "windows",
    iPhone: null, iPad: null, android: null, linux: null, chromebook: null, silent: null,
  };
  for (const [name, platform] of Object.entries(expected)) {
    assert.equal(detect(BROWSERS[name]), platform, name);
  }
  assert.equal(detect(undefined), null, "no navigator at all");
});

test("a Mac gets the Mac button first and highlighted, and it fetches the Mac build", async () => {
  for (const name of ["safariMac", "chromeMac", "firefoxMac"]) {
    const page = await dashboard(BROWSERS[name]);
    const [first, second] = page.render(CATALOG, new Set(["1.5.6"]));
    assert.equal(first.platform, "macos", name);
    assert.equal(first.detected, true);
    assert.equal(first.button.className, "btn primary");
    assert.equal(first.button.textContent, "Download for Mac");
    assert.match(first.detail, /1\.5\.6/);
    // Both stay on the page.
    assert.equal(second.platform, "windows");
    assert.equal(second.detected, false);
    assert.equal(second.button.className, "btn");
    assert.equal(second.button.textContent, "Download for Windows");
    assert.equal(page.box.hidden, false);
    first.button.listeners.click();
    assert.deepEqual(page.downloaded, [15], `${name}: the Mac button fetched row 15, not the newer Windows row 16`);
    assert.match(page.note.textContent, /a Mac/);
  }
});

test("a Windows PC gets the Windows button first and highlighted, and it fetches the Windows build", async () => {
  for (const name of ["edgeWindows", "firefoxWindows"]) {
    const page = await dashboard(BROWSERS[name]);
    const [first, second] = page.render(CATALOG, new Set(["1.5.6"]));
    assert.equal(first.platform, "windows", name);
    assert.equal(first.detected, true);
    assert.equal(first.button.className, "btn primary");
    assert.equal(second.platform, "macos");
    assert.equal(second.detected, false);
    first.button.listeners.click();
    second.button.listeners.click();
    assert.deepEqual(page.downloaded, [16, 15], "each button fetches only its own platform");
  }
});

test("a phone, a tablet or an unknown system sees both buttons, neither preselected", async () => {
  for (const name of ["iPhone", "iPad", "android", "linux", "chromebook", "silent"]) {
    const page = await dashboard(BROWSERS[name]);
    const choices = page.render(CATALOG, new Set(["1.5.6"]));
    assert.deepEqual(choices.map((c) => c.platform), ["macos", "windows"], name);
    assert.ok(choices.every((c) => !c.detected && c.button.className === "btn"), `${name}: nothing is highlighted`);
    assert.match(page.note.textContent, /Choose the build/);
    choices[0].button.listeners.click();
    assert.deepEqual(page.downloaded, [15]);
  }
});

test("an account that does not own the build is offered that platform's build to buy", async () => {
  const page = await dashboard(BROWSERS.safariMac);
  const [mac] = page.render(CATALOG, new Set());
  assert.equal(mac.button.textContent, "Buy — $50.00");
  assert.equal(mac.button.className, "btn primary", "still highlighted");
  mac.button.listeners.click();
  assert.deepEqual(page.bought, [15]);
  assert.deepEqual(page.downloaded, []);
});

test("a platform with nothing published keeps its button, disabled, and never borrows the other build", async () => {
  const page = await dashboard(BROWSERS.edgeWindows);
  const choices = page.render(CATALOG.filter((b) => b.platform === "macos"), new Set(["1.5.6"]));
  const windows = choices.find((c) => c.platform === "windows");
  assert.equal(windows.button.disabled, true);
  assert.equal(windows.button.listeners.click, undefined);
  assert.match(windows.detail, /not published yet/);

  const macless = await dashboard(BROWSERS.safariMac);
  const mac = macless.render(CATALOG.filter((b) => b.platform === "windows"), new Set(["1.5.6"]))
    .find((c) => c.platform === "macos");
  assert.equal(mac.button.disabled, true, "a Mac is never handed the Windows build in its place");
  assert.equal(mac.button.listeners.click, undefined);
});
