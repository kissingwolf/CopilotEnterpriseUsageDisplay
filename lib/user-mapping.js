const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const DEBOUNCE_MS = 300;

class UserMappingService {
  constructor() {
    if (UserMappingService._instance) {
      return UserMappingService._instance;
    }
    this.dataPath = path.join(__dirname, "..", "data", "user_mapping.json");
    this.userMap = new Map();
    this.rawData = [];
    this.fetchedAt = null;
    this._watcher = null;
    this._debounceTimer = null;
    this._ensureDataFile();
    this._load();
    this._watch();
    UserMappingService._instance = this;
  }

  _ensureDataFile() {
    try {
      if (!fs.existsSync(this.dataPath)) {
        const dir = path.dirname(this.dataPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.dataPath, "[]", "utf8");
      }
    } catch (err) {
      logger.error({ err: err.message }, "UserMappingService: failed to ensure data file");
    }
  }

  _load() {
    try {
      const content = fs.readFileSync(this.dataPath, "utf8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        logger.error("UserMappingService: data file must contain an array");
        return;
      }

      const newMap = new Map();
      const validEntries = [];
      let skippedCount = 0;

      for (const row of parsed) {
        const trimmedAdName = (row["AD-name"] || "").trim();
        const trimmedAdMail = (row["AD-mail"] || "").trim();
        const trimmedGithubName = (row["Github-name"] || "").trim();
        const trimmedGithubMail = (row["Github-mail"] || "").trim();

        if (!trimmedAdName || !trimmedGithubName) {
          skippedCount++;
          continue;
        }

        const key = trimmedGithubName.toLowerCase();
        const value = {
          adName: trimmedAdName,
          adMail: trimmedAdMail,
          githubName: trimmedGithubName,
          githubMail: trimmedGithubMail,
        };

        newMap.set(key, value);
        validEntries.push({
          "AD-name": trimmedAdName,
          "AD-mail": trimmedAdMail,
          "Github-name": trimmedGithubName,
          "Github-mail": trimmedGithubMail,
        });
      }

      this.userMap = newMap;
      this.rawData = validEntries;
      this.fetchedAt = new Date().toISOString();
      logger.info(
        { valid: validEntries.length, skipped: skippedCount },
        "UserMappingService: loaded mappings"
      );
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.warn("UserMappingService: data file not found, using empty mapping");
      } else {
        logger.error({ err: err.message }, "UserMappingService: failed to load data");
      }
    }
  }

  /**
   * Use fs.watch (inotify / kqueue) instead of fs.watchFile (polling).
   * A debounce guard prevents rapid successive reloads.
   */
  _watch() {
    try {
      this._watcher = fs.watch(this.dataPath, (_eventType) => {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          logger.info("UserMappingService: data file changed, reloading...");
          this._load();
        }, DEBOUNCE_MS);
      });

      /* Handle watcher errors gracefully – fall back to no-watch */
      this._watcher.on("error", (err) => {
        logger.warn({ err: err.message }, "UserMappingService: fs.watch error, falling back");
        this._closeWatcher();
      });
    } catch (err) {
      logger.warn({ err: err.message }, "UserMappingService: could not start fs.watch");
    }
  }

  getUserByGithub(githubLogin) {
    if (!githubLogin) return null;
    const normalized = githubLogin.trim().toLowerCase();
    return this.userMap.get(normalized) || null;
  }

  getADUserByGithubName(githubName) {
    return this.getUserByGithub(githubName);
  }

  getAllMapped() {
    return this.rawData.slice();
  }

  getFetchedAt() {
    return this.fetchedAt;
  }

  getSize() {
    return this.userMap.size;
  }

  reload() {
    this._load();
  }

  _closeWatcher() {
    clearTimeout(this._debounceTimer);
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  close() {
    this._closeWatcher();
  }
}

module.exports = UserMappingService;
