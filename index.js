const fs = require('fs')

// list all directories in the directory servapps and compile them in servapps.json

const servapps = fs.readdirSync('./servapps').filter(file => fs.lstatSync(`./servapps/${file}`).isDirectory())

let servappsJSON = []

for (const file of servapps) {
  const servapp = require(`./servapps/${file}/description.json`)
  servappsJSON.push(servapp)
}

fs.writeFileSync('./servapps.json', JSON.stringify(servappsJSON, null, 2))