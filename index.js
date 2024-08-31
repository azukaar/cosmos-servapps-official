const fs = require('fs');

// Load configuration from config.json
const { config } = require('process')
const configFile = require('./config.json')

// Constants
const GITHUB_PAGES_URL = `https://${process.env.GITHUB_PAGES_URL}`;
const LOCALHOST_URL = "http://LOCALHOST_URL:3000";
const INPUT_SERVAPPS_DIR = './servapps';
const OUTPUT_FILES = {
  SERVAPPS_JSON: './servapps.json',
  INDEX_JSON: './index.json',
  SERVAPPS_TEST_JSON: './servapps_test.json',
};
const SHOWCASE_APPS = configFile.showcase;

// Servapp Class
class Servapp {
  constructor(id, baseUrl) {
    this.id = id;
    this.baseUrl = baseUrl;
    this.description = this.loadDescription();
    this.screenshots = this.loadScreenshots();
    this.artefacts = this.loadArtefacts();
    this.icon = this.loadIcon();
    this.compose = this.loadComposeSource();
  }

  loadDescription() {
    return readJSONFile(`./servapps/${this.id}/description.json`);
  }

  loadScreenshots() {
    const screenshotsDir = `./servapps/${this.id}/screenshots`;
    if (fs.existsSync(screenshotsDir)) {
      return fs.readdirSync(screenshotsDir).map(screenshot => `${this.baseUrl}/servapps/${this.id}/screenshots/${screenshot}`);
    }
    return [];
  }

  loadArtefacts() {
    const artefactsDir = `./servapps/${this.id}/artefacts`;
    const artefacts = {};
    if (fs.existsSync(artefactsDir)) {
      fs.readdirSync(artefactsDir).forEach(artefact => {
        artefacts[artefact] = `${this.baseUrl}/servapps/${this.id}/artefacts/${artefact}`;
      });
    }
    return artefacts;
  }

  loadIcon() {
    return `${this.baseUrl}/servapps/${this.id}/icon.png`;
  }

  loadComposeSource() {
    const dockerComposePath = `${this.baseUrl}/servapps/${this.id}/docker-compose.yml`;
    const cosmosComposePath = `${this.baseUrl}/servapps/${this.id}/cosmos-compose.json`;

    if (fs.existsSync(`./servapps/${this.id}/docker-compose.yml`)) {
      return dockerComposePath;
    }

    if (fs.existsSync(`./servapps/${this.id}/cosmos-compose.json`)) {
      return cosmosComposePath;
    }

    return null;
  }

  toJSON() {
    return {
      ...this.description,
      id: this.id,
      screenshots: this.screenshots,
      artefacts: this.artefacts,
      icon: this.icon,
      compose: this.compose
    };
  }
}

// Funcs Utils
const getDirectoryContents = (dirPath) => fs.readdirSync(dirPath).filter(file => fs.lstatSync(`${dirPath}/${file}`).isDirectory());
const readJSONFile = (filePath) => require(filePath);
const writeJSONFile = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

// Main Class
class ServappManager {
  constructor(githubPagesUrl, localhostUrl, inputDir, showcaseApps) {
    this.githubPagesUrl = githubPagesUrl;
    this.localhostUrl = localhostUrl;
    this.inputDir = inputDir;
    this.showcaseApps = showcaseApps;

    this.servapps = this.loadServapps(this.githubPagesUrl);
    this.servappsLocalhost = this.loadServapps(this.localhostUrl);
  }

  loadServapps(baseUrl) {
    const servappsDirs = getDirectoryContents(this.inputDir);
    return servappsDirs.map(file => new Servapp(file, baseUrl));
  }

  generateServappsJSON(servapps) {
    return servapps.map(servapp => servapp.toJSON());
  }

  filterServapps(servapps, servappsToExclude) {
    return servapps.filter(servapp => servappsToExclude.includes(servapp.description.name));
  }

  generateIndexJSON(servapps, baseUrl) {
    const showcaseAppsJSON = this.filterServapps(servapps, this.showcaseApps);

    return {
      source: `${baseUrl}/servapps.json`,
      showcase: this.generateServappsJSON(showcaseAppsJSON),
      all: this.generateServappsJSON(servapps)
    };
  }

  saveJSONFiles(outputFiles) {
    // Generate JSON data for the GitHub Pages environment
    const servappsJson = this.generateServappsJSON(this.servapps);
    const indexJson = this.generateIndexJSON(this.servapps, this.githubPagesUrl);

    // Write the JSON data to the corresponding files
    writeJSONFile(outputFiles.SERVAPPS_JSON, servappsJson);
    writeJSONFile(outputFiles.INDEX_JSON, indexJson);

    // Generate JSON data for the localhost environment
    const servappsLocalhostJson = this.generateServappsJSON(this.servappsLocalhost);
    const indexLocalhostJson = this.generateIndexJSON(this.servappsLocalhost, this.localhostUrl);

    // Write the localhost JSON data to the test output file
    writeJSONFile(outputFiles.SERVAPPS_TEST_JSON, servappsLocalhostJson);
  }
}

// RUN
const servappManager = new ServappManager(
  GITHUB_PAGES_URL,
  LOCALHOST_URL,
  INPUT_SERVAPPS_DIR,
  SHOWCASE_APPS
);

servappManager.saveJSONFiles(OUTPUT_FILES);
