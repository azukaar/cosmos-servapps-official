const fs = require('fs')
const githubPagesUrl = `https://${process.env.GITHUB_PAGES_URL}`
const localhost = "http://localhost:3000"


// list all directories in the directory servapps and compile them in servapps.json

const servapps = fs.readdirSync('./servapps').filter(file => fs.lstatSync(`./servapps/${file}`).isDirectory())

let servappsJSON = []

for (const file of servapps) {
  const servapp = require(`./servapps/${file}/description.json`)
  servapp.id = file
  servapp.screenshots = [];
  servapp.artefacts = {};

  // list all screenshots in the directory servapps/${file}/screenshots
  const screenshots = fs.readdirSync(`./servapps/${file}/screenshots`)
  for (const screenshot of screenshots) {
    servapp.screenshots.push(`${githubPagesUrl}/servapps/${file}/screenshots/${screenshot}`)
  }

  if(fs.existsSync(`./servapps/${file}/artefacts`)) {
    const artefacts = fs.readdirSync(`./servapps/${file}/artefacts`)
    for(const artefact of artefacts) {
      servapp.artefacts[artefact] = (`${githubPagesUrl}/servapps/${file}/artefacts/${artefact}`)
    }
  }

  servapp.icon = `${githubPagesUrl}/servapps/${file}/icon.png`
  //Common Format,used by most
  const YMLComposeSource =  `${githubPagesUrl}/servapps/${file}/docker-compose.yml`;
  if(fs.existsSync(`./servapps/${file}/docker-compose.yml`)) {
    servapp.compose = YMLComposeSource;
  }
  //Cosmos Legacy Format
  const CosmosComposeSource =  `${githubPagesUrl}/servapps/${file}/cosmos-compose.json`; 
  if(fs.existsSync(`./servapps/${file}/cosmos-compose.json`)) {
    servapp.compose = CosmosComposeSource;
    }

  servappsJSON.push(servapp)
}

// add showcase
const _sc = ["Jellyfin", "Home Assistant", "Nextcloud"];
const showcases = servappsJSON.filter((app) => _sc.includes(app.name));

let apps = {
  "source": `${githubPagesUrl}/servapps.json`,
  "showcase": showcases,
  "all": servappsJSON
}

fs.writeFileSync('./servapps.json', JSON.stringify(servappsJSON, null, 2))
fs.writeFileSync('./index.json', JSON.stringify(apps, null, 2))

for (const servapp of servappsJSON) {
  servapp.compose = `${localhost}/servapps/${servapp.id}/cosmos-compose.json`
  servapp.icon = `${localhost}/servapps/${servapp.id}/icon.png`
  for (let i = 0; i < servapp.screenshots.length; i++) {
    servapp.screenshots[i] = servapp.screenshots[i].replace('${githubPagesUrl}', '${localhost}')
  }
  for (const artefact in servapp.artefacts) {
    servapp.artefacts[artefact] = servapp.artefacts[artefact].replace('${githubPagesUrl}', '${localhost}')
  }
}

fs.writeFileSync('./servapps_test.json', JSON.stringify(apps, null, 2))
