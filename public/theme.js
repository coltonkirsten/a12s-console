// Runs before paint so the page never flashes the wrong theme. CSP allows only same-origin scripts.
try {
  var t = localStorage.getItem("a12s-console-theme") || "system";
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
} catch (e) {}
