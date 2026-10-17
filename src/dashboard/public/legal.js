// The Terms and Privacy pages: use the look picked on the dashboard (saved in
// this browser by app.js). Loaded in <head> so the page never flashes the wrong theme.

const NAME = /^[a-z-]{1,20}$/;

try {
  const saved = JSON.parse(localStorage.getItem("appearance") ?? "null") ?? {};
  const root = document.documentElement;
  if (NAME.test(saved.theme) && saved.theme !== "auto") {
    root.dataset.theme = saved.theme;
  }
  for (const key of ["accent", "density", "style"]) {
    if (NAME.test(saved[key])) {
      root.dataset[key] = saved[key];
    }
  }
} catch {
  // Private windows may refuse storage; the default look is used.
}
