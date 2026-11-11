// Light / dark switch. Loaded in <head> (not deferred) so a saved choice applies before the page is
// drawn, with no flash of the other colours. Without a choice the page follows the system setting
// (style.css). The choice is kept in this browser only; if storage is blocked, it lasts for the page.
"use strict";
(function () {
  var KEY = "harbourline-theme";
  var root = document.documentElement;
  var dark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch (e) {}

  function current() {
    return root.dataset.theme || (dark && dark.matches ? "dark" : "light");
  }

  function update(button) {
    var isDark = current() === "dark";
    var next = isDark ? "light" : "dark";
    button.setAttribute("aria-label", "Switch to " + next + " mode");
    button.title = "Switch to " + next + " mode";
    button.querySelector(".theme-label").textContent = isDark ? "Light" : "Dark";
    // SVG elements have no .hidden property, so set the attribute itself.
    button.querySelector(".icon-sun").toggleAttribute("hidden", !isDark);
    button.querySelector(".icon-moon").toggleAttribute("hidden", isDark);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    update(button);
    button.hidden = false;
    button.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
      update(button);
    });
    if (dark && dark.addEventListener) dark.addEventListener("change", function () { update(button); });
  });
})();
