(() => {
  let preference;
  try {
    preference = localStorage.getItem("native-sfu-theme");
  } catch {
    // Storage can be unavailable in private browsing.
  }
  const theme =
    preference === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference === "light"
        ? "light"
        : "dark";
  document.documentElement.dataset.theme = theme;
})();
