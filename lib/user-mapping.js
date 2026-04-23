const fs = require('fs');
const path = require('path');

class UserMappingService {
  constructor() {
    if (UserMappingService._instance) {
      return UserMappingService._instance;
    }
    this.dataPath = path.join(__dirname, '..', 'data', 'user_mapping.json');
    this.userMap = new Map();
    this.rawData = [];
    this.fetchedAt = null;
    this.watcherActive = false;
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
        fs.writeFileSync(this.dataPath, '[]', 'utf8');
      }
    } catch (err) {
      console.error('UserMappingService: failed to ensure data file:', err.message);
    }
  }

  _load() {
    try {
      const content = fs.readFileSync(this.dataPath, 'utf8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.error('UserMappingService: data file must contain an array');
        return;
      }

      const validEntries = [];
      let skippedCount = 0;

      for (const row of parsed) {
        const trimmedAdName = (row['AD-name'] || '').trim();
        const trimmedAdMail = (row['AD-mail'] || '').trim();
        const trimmedGithubName = (row['Github-name'] || '').trim();
        const trimmedGithubMail = (row['Github-mail'] || '').trim();

        if (!trimmedAdName || !trimmedGithubName) {
          console.warn('UserMappingService: skipping invalid row - missing AD-name or Github-name:', row);
          skippedCount++;
          continue;
        }

        const key = trimmedGithubName.toLowerCase();
        const value = {
          adName: trimmedAdName,
          adMail: trimmedAdMail,
          githubName: trimmedGithubName,
          githubMail: trimmedGithubMail
        };

        this.userMap.set(key, value);
        validEntries.push({
          'AD-name': trimmedAdName,
          'AD-mail': trimmedAdMail,
          'Github-name': trimmedGithubName,
          'Github-mail': trimmedGithubMail
        });
      }

      this.rawData = validEntries;
      this.fetchedAt = new Date().toISOString();
      console.log(`UserMappingService: loaded ${validEntries.length} valid mappings (skipped ${skippedCount} invalid rows)`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn('UserMappingService: data file not found, using empty mapping');
      } else {
        console.error('UserMappingService: failed to load data:', err.message);
      }
    }
  }

  _watch() {
    fs.watchFile(this.dataPath, (curr, prev) => {
      if (curr.mtimeMs > prev.mtimeMs) {
        console.log('UserMappingService: data file changed, reloading...');
        this.userMap.clear();
        this._load();
      }
    });
    this.watcherActive = true;
  }

  getUserByGithub(githubLogin) {
    if (!githubLogin) {
      return null;
    }
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
    this.userMap.clear();
    this._load();
  }

  close() {
    if (this.watcherActive) {
      fs.unwatchFile(this.dataPath);
      this.watcherActive = false;
    }
  }
}

module.exports = UserMappingService;
