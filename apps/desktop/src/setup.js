document.getElementById("setup").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    await window.classroomSetup.save({
      serverUrl: document.getElementById("server").value.trim(),
      websiteUrl: document.getElementById("website").value.trim(),
    });
  } catch (error) {
    document.getElementById("error").textContent = String(
      error.message || "Unable to connect. Check the server address.",
    ).replace(/^Error invoking remote method[^:]*:/, "");
    button.disabled = false;
  }
};
