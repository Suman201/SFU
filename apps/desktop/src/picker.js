let selected = null;
window.capturePicker
  .sources()
  .then((sources) => {
    const container = document.getElementById("sources");
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "source";
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      const image = document.createElement("img");
      image.src = source.thumbnail;
      image.alt = "";
      const label = document.createElement("span");
      label.textContent = source.name;
      button.append(image, label);
      button.onclick = () => {
        selected = source.id;
        for (const sibling of container.children)
          sibling.setAttribute("aria-pressed", String(sibling === button));
        document.getElementById("share").disabled = false;
      };
      container.append(button);
    }
    if (!sources.length)
      document.getElementById("error").textContent =
        "No screens are available. Check screen recording permission in your system settings.";
  })
  .catch(
    () =>
      (document.getElementById("error").textContent =
        "Unable to list screens. Check your system screen recording permission."),
  );
document.getElementById("cancel").onclick = () => window.capturePicker.cancel();
document.getElementById("share").onclick = () =>
  window.capturePicker.choose(
    selected,
    document.getElementById("audio").checked,
  );
