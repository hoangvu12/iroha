import { openDatabase } from '../src/persistence/index.ts'
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher } from '../src/crypto/index.ts'

const config = loadConfiguration(Bun.env)
const database = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

try {
  const keys = await database.gatewayKeys.list()
  console.log('Gateway keys:')
  for (const key of keys) {
    const revealed = await database.gatewayKeys.reveal(key.id, cipher)
    console.log(`  ${key.id}: ${key.name}`)
    console.log(`    Key: ${revealed}`)
  }
} finally {
  await database.close()
}
