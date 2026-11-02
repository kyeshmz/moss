import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { desktopPlatform } from "../src/App";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const [light, dark] = styles.split("@media (prefers-color-scheme: dark)");

function token(source: string, name: string) {
  const match = source.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `Missing ${name}`);
  return match[1];
}

test("light and dark shell surfaces use the OpenCode 2.2.5 oc-2 neutrals", () => {
  assert.deepEqual(["background-base", "background-deep", "surface-raised", "surface-hover", "text-strong", "text-muted"]
    .map(name => token(light, name)), ["#ffffff", "#fafafa", "#f2f2f2", "#eeeeee", "#161616", "#5c5c5c"]);
  assert.deepEqual(["background-base", "background-deep", "surface-raised", "surface-hover", "text-strong", "text-muted"]
    .map(name => token(dark, name)), ["#161616", "#080808", "#242424", "#2e2e2e", "#fafafa", "#aeaeae"]);
  assert.match(light, /color-scheme: light;/);
  assert.match(dark, /color-scheme: dark;/);
});

test("desktop shell keeps compact source dimensions and sans/mono font stacks", () => {
  assert.deepEqual(["sidebar-width", "header-height", "control-height", "control-height-small"].map(name => token(light, name)),
    ["276px", "36px", "32px", "28px"]);
  assert.match(token(light, "font-sans"), /^"Inter", ui-sans-serif, system-ui/);
  assert.match(token(light, "font-mono"), /^"IBM Plex Mono", ui-monospace/);
  assert.doesNotMatch(styles, /Georgia|Times New Roman|--olive|--cream|welcome-art/);
});

test("muted copy and recovery messages retain readable contrast in both appearances", () => {
  function luminance(hex: string) {
    const [r, g, b] = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return r * .2126 + g * .7152 + b * .0722;
  }
  for (const appearance of [light, dark]) {
    for (const [foreground, background] of [["text-muted", "background-base"], ["success-text", "success-background"],
      ["warning-text", "warning-background"], ["danger-text", "danger-background"]]) {
      const values = [luminance(token(appearance, foreground)), luminance(token(appearance, background))].sort((a, b) => b - a);
      const contrast = (values[0] + .05) / (values[1] + .05);
      assert.ok(contrast >= 4.5, `${foreground} on ${background} has ${contrast.toFixed(2)}:1 contrast`);
    }
  }
});

test("desktop chrome flags accept only the host's layout-only platform values", () => {
  assert.equal(desktopPlatform("?desktop=darwin"), "darwin");
  assert.equal(desktopPlatform("?desktop=win32"), "win32");
  assert.equal(desktopPlatform("?desktop=linux"), "linux");
  assert.equal(desktopPlatform(""), undefined);
  assert.equal(desktopPlatform("?desktop=unknown"), undefined);
  assert.equal(desktopPlatform("?desktop=true"), undefined);
  assert.equal(desktopPlatform("?other=darwin"), undefined);
});

test("native chrome has traffic-light and caption insets without dragging controls", () => {
  assert.match(styles, /\[data-desktop="darwin"\] \.brand-slot \{ padding-left: 80px; \}/);
  assert.match(styles, /\[data-desktop="win32"\] \.topbar \{ padding-right: 150px; \}/);
  assert.match(styles, /\[data-desktop\] \.topbar \{ -webkit-app-region: drag; app-region: drag; \}/);
  assert.match(styles, /\[data-desktop\] :is\(button, a, input, textarea, label, \[role="tab"\], \.breadcrumbs, \.local-badge\) \{ -webkit-app-region: no-drag; app-region: no-drag; \}/);
});
