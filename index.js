const fs = require('fs')

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
    servapp.screenshots.push(`https://comos.manhtuong.net/servapps/${file}/screenshots/${screenshot}`)
  }

  if(fs.existsSync(`./servapps/${file}/artefacts`)) {
    const artefacts = fs.readdirSync(`./servapps/${file}/artefacts`)
    for(const artefact of artefacts) {
      servapp.artefacts[artefact] = (`https://comos.manhtuong.net/servapps/${file}/artefacts/${artefact}`)
    }
  }

  servapp.icon = `https://comos.manhtuong.net/servapps/${file}/icon.png`
  servapp.compose = `https://comos.manhtuong.net/servapps/${file}/cosmos-compose.json`

  servappsJSON.push(servapp)
}

fs.writeFileSync('./servapps.json', JSON.stringify(servappsJSON, null, 2))

for (const servapp of servappsJSON) {
  servapp.compose = `http://localhost:3000/servapps/${servapp.id}/cosmos-compose.json`
  servapp.icon = `http://localhost:3000/servapps/${servapp.id}/icon.png`
  for (let i = 0; i < servapp.screenshots.length; i++) {
    servapp.screenshots[i] = servapp.screenshots[i].replace('https://comos.manhtuong.net', 'http://localhost:3000')
  }
  for (const artefact in servapp.artefacts) {
    servapp.artefacts[artefact] = servapp.artefacts[artefact].replace('https://comos.manhtuong.net', 'http://localhost:3000')
  }
}

fs.writeFileSync('./servapps_test.json', JSON.stringify({
  source: "",
  showcase: [],
  all: servappsJSON,
}, null, 2))
