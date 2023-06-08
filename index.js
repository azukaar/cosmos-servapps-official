const fs = require('fs')

// list all directories in the directory servapps and compile them in servapps.json

const servapps = fs.readdirSync('./servapps').filter(file => fs.lstatSync(`./servapps/${file}`).isDirectory())

let servappsJSON = []

for (const file of servapps) {
  const servapp = require(`./servapps/${file}/description.json`)
  servapp.screenshots = [];

  // list all screenshots in the directory servapps/${file}/screenshots
  const screenshots = fs.readdirSync(`./servapps/${file}/screenshots`)
  for (const screenshot of screenshots) {
    servapp.screenshots.push(`https://azukaar.github.io/cosmos-servapps-official/servapps/${file}/screenshots/${screenshot}`)
  }

  servapp.icon = `https://azukaar.github.io/cosmos-servapps-official/servapps/${file}/icon.png`
  servapp.compose = `https://azukaar.github.io/cosmos-servapps-official/servapps/${file}/cosmos-compose.json`

  servappsJSON.push(servapp)
}

fs.writeFileSync('./servapps.json', JSON.stringify(servappsJSON, null, 2))