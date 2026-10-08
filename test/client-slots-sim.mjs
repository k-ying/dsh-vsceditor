// client-slots-sim.mjs — drives the REAL lib/client.js against a stubbed module
// loader, a stubbed DOM, and a stubbed `slots` service, to pin the settings-surface
// arbitration.
//
// Why this exists: the settings surface moved from `settings.plugin.item` (a keyed
// card nested inside the shipped "configurable" tab) to `settings.plugins.tab` (a
// list of tabs). dsh 0.2.x declares only the new one — but 0.1.x declares BOTH (its
// `settings.plugins.tab` holds a shipped "configurable" tab whose children include
// `settings.plugin.item`), so registering into both rendered the very same settings
// surface twice on 0.1.x. That was a 0.5.4 regression; this file locks the contract:
//
//   whatever the shell declares, and in whatever order, the plugin ends up with
//   EXACTLY ONE active settings registration, and it is the tab whenever the
//   `settings.plugins.tab` slot exists.
//
// The suite stays dependency-free: `react` is a three-member stub (the real
// components never render here) and the slot service implements the two documented
// semantics this contract depends on — `inject` on an undeclared slot WAITS
// (specDynamic(key) === undefined -> return, in both 0.1.5 and 0.2.1) instead of
// throwing, and `register` returns a disposer.

import { createRequire } from "node:module";

const failed = [];
let checks = 0;
function check(cond, label) { checks++; if (!cond) failed.push(label); }

// ── stubs: the three React members client.js actually uses ──
const fakeReact = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};

// ── stubs: browser globals touched by apply() ──
let definition = null;
globalThis.window = {
  __ModuleLoader__: { load: (def) => { definition = def; } },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = {
  createElement: () => ({ textContent: "", remove: () => {} }),
  head: { appendChild: () => {} },
};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// ── load the real module through its real entry point ──
createRequire(import.meta.url)("../lib/client.js");
check(definition !== null, "client.js calls window.__ModuleLoader__.load()");
check(definition !== null && definition.id === "dsh-vsceditor", "the loaded module declares id 'dsh-vsceditor'");

const client = definition.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error(`unexpected require(${JSON.stringify(name)})`);
});
check(typeof client.apply === "function", "client.js exports apply()");
check(Array.isArray(client.inject) && client.inject.includes("slots"), "client.js injects the 'slots' service");

// ── a slots service with the semantics the contract rests on ──
function makeHarness(initiallyDeclared) {
  const declared = new Set(initiallyDeclared);
  const entries = [];
  const waiters = new Map(); // slot -> Set<{ callback, disposer, active }>

  function track(slot) {
    if (!waiters.has(slot)) waiters.set(slot, new Set());
    return waiters.get(slot);
  }
  // A declaration runs every pending callback once; a collapse disposes whatever
  // those callbacks installed; a re-declaration runs them again — the lifetime
  // semantics slots.inject documents ("the callback runs synchronously when the
  // declaration already exists ... Collapse disposes the effect and a later
  // declaration runs it again").
  function wake(slot) {
    for (const waiter of track(slot)) {
      if (waiter.active && waiter.disposer === null) waiter.disposer = waiter.callback();
    }
  }
  function sleep(slot) {
    for (const waiter of track(slot)) {
      const dispose = waiter.disposer;
      waiter.disposer = null;
      if (typeof dispose === "function") dispose();
    }
  }

  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
    get() { return undefined; }, // no `locale` service: the locale effect bails out
    slots: {
      inject(slot, callback) {
        const waiter = { callback, disposer: null, active: true };
        track(slot).add(waiter);
        if (declared.has(slot)) waiter.disposer = callback();
        return () => {
          waiter.active = false;
          const dispose = waiter.disposer;
          waiter.disposer = null;
          if (typeof dispose === "function") dispose();
          track(slot).delete(waiter);
        };
      },
      register(options, component) {
        const entry = { slot: options.name, options, component, active: true };
        entries.push(entry);
        return () => { entry.active = false; };
      },
    },
  };

  return {
    ctx,
    active: (slot) => entries.filter((e) => e.active && e.slot === slot),
    activeSettings: () => entries.filter((e) => e.active && e.slot.startsWith("settings.")),
    declare(slot) { if (!declared.has(slot)) { declared.add(slot); wake(slot); } },
    collapse(slot) { if (declared.has(slot)) { declared.delete(slot); sleep(slot); } },
  };
}

function applyTo(initiallyDeclared) {
  const harness = makeHarness(initiallyDeclared);
  client.apply(harness.ctx);
  return harness;
}

// ── shape A: dsh 0.1.x declares BOTH slots (the 0.5.4 regression) ──
{
  const h = applyTo(["conversation.view", "settings.plugins.tab", "settings.plugin.item"]);
  check(h.active("conversation.view").length === 1, "0.1.x shape: the editor view is registered once");
  check(h.activeSettings().length === 1, `0.1.x shape: exactly one settings surface (got ${h.activeSettings().length})`);
  check(h.active("settings.plugins.tab").length === 1, "0.1.x shape: the settings surface is the tab");
  check(h.active("settings.plugin.item").length === 0, "0.1.x shape: no second card is left behind");
  const tabEntry = h.active("settings.plugins.tab")[0];
  check(tabEntry !== undefined && typeof tabEntry.options.label === "function", "0.1.x shape: the tab label is a thunk (re-resolved on locale change)");
}

// ── shape B: dsh 0.2.x declares only the tab ──
{
  const h = applyTo(["conversation.view", "settings.plugins.tab"]);
  check(h.activeSettings().length === 1, `0.2.x shape: exactly one settings surface (got ${h.activeSettings().length})`);
  check(h.active("settings.plugins.tab").length === 1, "0.2.x shape: the settings surface is the tab");
}

// ── shape C: a shell that only has the legacy card slot ──
{
  const h = applyTo(["conversation.view", "settings.plugin.item"]);
  check(h.activeSettings().length === 1, `legacy shape: exactly one settings surface (got ${h.activeSettings().length})`);
  check(h.active("settings.plugin.item").length === 1, "legacy shape: the card is used as the fallback");
  const cardEntry = h.active("settings.plugin.item")[0];
  check(cardEntry !== undefined && cardEntry.options.key === "dsh-vsceditor", "legacy shape: the card is keyed by the settings namespace");
}

// ── shape D: declaration order must not matter — card first, tab later ──
{
  const h = applyTo(["conversation.view", "settings.plugin.item"]);
  check(h.active("settings.plugin.item").length === 1, "card-first: the fallback card registers while no tab exists");
  h.declare("settings.plugins.tab");
  check(h.active("settings.plugin.item").length === 0, "card-first: a tab declared later retracts the fallback card");
  check(h.activeSettings().length === 1, `card-first: exactly one settings surface remains (got ${h.activeSettings().length})`);
  check(h.active("settings.plugins.tab").length === 1, "card-first: the survivor is the tab");
}

// ── shape E: nothing declared yet, the tab arrives much later ──
{
  const h = applyTo(["conversation.view"]);
  check(h.activeSettings().length === 0, "late-declaration: nothing is registered before any settings slot exists");
  h.declare("settings.plugins.tab");
  check(h.activeSettings().length === 1, `late-declaration: the later declaration still yields one surface (got ${h.activeSettings().length})`);
  check(h.active("settings.plugins.tab").length === 1, "late-declaration: it is the tab");
}

// ── shape F: a slot collapse must not leave a stale card behind ──
{
  const h = applyTo(["conversation.view", "settings.plugins.tab", "settings.plugin.item"]);
  h.collapse("settings.plugins.tab");
  check(h.activeSettings().length === 0, `collapse: the tab's own disposal leaves nothing registered (got ${h.activeSettings().length})`);
}

// ── shape G: a re-declaration runs the callback again, still exactly once ──
{
  const h = applyTo(["conversation.view", "settings.plugins.tab"]);
  h.collapse("settings.plugins.tab");
  check(h.activeSettings().length === 0, "re-declaration: collapse disposes the tab");
  h.declare("settings.plugins.tab");
  check(h.active("settings.plugins.tab").length === 1, "re-declaration: the tab comes back");
  check(h.activeSettings().length === 1, `re-declaration: still exactly one settings surface (got ${h.activeSettings().length})`);
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("CLIENT SLOTS SIM FAILED");
  process.exit(1);
}
console.log(`CLIENT SLOTS SIM PASSED (${checks} checks)`);
