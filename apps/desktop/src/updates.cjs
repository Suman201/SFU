"use strict";
class UpdateController {
  constructor({ updater, available, onState, beforeInstall = () => {} }) {
    this.updater = updater;
    this.available = available;
    this.onState = onState;
    this.beforeInstall = beforeInstall;
    this.active = false;
    this.checkPending = false;
    this.downloadPending = false;
    this.ready = false;
    this.downloadedVersion = null;
    this.state = {
      status: available ? "idle" : "unavailable",
      message: available
        ? "Check for classroom updates."
        : "Updates are managed by your institution. Install its latest signed app when available.",
    };
    if (!available) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("update-available", (info) => {
      if (this.version !== info.version) { this.ready = false; this.downloadedVersion = null; }
      this.version = info.version;
      this.set(
        this.active ? "deferred" : this.ready ? "ready" : "available",
        this.active ? "Update available. Download outside class." : this.ready ? "Update ready. Restart to install." : "An update is available. Download and install when you are outside class.",
      );
    });
    updater.on("update-not-available", (info) => {
      if (this.ready && info?.version !== this.downloadedVersion) { this.ready = false; this.downloadedVersion = null; this.version = undefined; }
      this.set(this.active ? "deferred" : this.ready ? "ready" : "idle", this.active ? "Updates are paused while class is open." : this.ready ? "Update ready. Restart to install." : "You are using the latest version.");
    });
    updater.on("download-progress", (progress) => this.active ? undefined :
      this.set(
        "downloading",
        `Downloading update: ${Math.floor(progress.percent)}%`,
      ),
    );
    updater.on("update-downloaded", (info) => {
      if (this.version && this.version !== info.version) return;
      this.downloadedVersion = info.version;
      this.ready = true;
      this.version = info.version;
      this.set(
        this.active ? "deferred" : "ready",
        this.active
          ? "Update ready. Installation is paused until you leave class."
          : "Update ready. Restart to install.",
      );
    });
    updater.on("error", () => {
      this.ready = false; this.downloadedVersion = null; this.version = undefined;
      this.set(this.active ? "deferred" : "error", this.active ? "Updates are paused while class is open." : "The update could not be completed. Your current app is unchanged. Try again later.");
    });
  }
  set(status, message) {
    this.state = {
      status,
      message,
      ...(this.version ? { version: this.version } : {}),
    };
    this.onState(this.state);
    return this.state;
  }
  setActive(value) {
    this.active = value;
    if (value && this.cancelDownload) {
      this.cancelDownload.cancel();
      this.cancelDownload = null;
      this.set("deferred", "Update download paused while class is open.");
    }
    if (value && (this.state.status === 'checking' || this.state.status === 'downloading')) this.set('deferred', 'Updates are paused while class is open.');
    if (!value && this.state.status === "deferred")
      this.set(
        this.ready ? "ready" : this.version ? "available" : "idle",
        this.ready
          ? "Update ready. Restart to install."
          : this.version
            ? "Update available. Download outside class."
            : "Check for classroom updates.",
      );
  }
  async check() {
    if (!this.available) return this.state;
    if (this.active)
      return this.set("deferred", "Updates are paused while class is open.");
    if (this.checkPending || this.downloadPending) return this.state;
    this.checkPending = true;
    this.set("checking", "Checking for updates…");
    try {
      const result = await this.updater.checkForUpdates();
      this.downloadToken = result?.cancellationToken;
    } catch {
      this.set("error", "Unable to check for updates. Try again later.");
    } finally {
      this.checkPending = false;
    }
    return this.state;
  }
  async install() {
    if (!this.available) return this.state;
    if (this.active)
      return this.set(
        "deferred",
        "Leave the classroom before installing an update.",
      );
    if (this.ready && this.downloadedVersion === this.version) {
      this.beforeInstall();
      this.updater.quitAndInstall(false, true);
      return this.state;
    }
    if (!this.version || this.downloadPending) return this.state;
    this.downloadPending = true;
    this.set("downloading", "Downloading the update…");
    try {
      if (!this.downloadToken || this.downloadToken.cancelled) {
        const result = await this.updater.checkForUpdates();
        this.downloadToken = result?.cancellationToken;
      }
      if (this.active || !this.downloadToken) return this.state;
      this.cancelDownload = this.downloadToken;
      await this.updater.downloadUpdate(this.cancelDownload);
    } catch {
      if (!this.active)
        this.set("error", "Unable to download the update. Try again later.");
    } finally {
      this.cancelDownload = null;
      this.downloadPending = false;
    }
    return this.state;
  }
}
module.exports = { UpdateController };
