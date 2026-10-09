// A stand-in audio player: notes the size of each file it is given, then "plays" for 50 ms.
import { appendFileSync, statSync } from "node:fs"
const file = process.argv[2]!
appendFileSync(process.env.PLAYLOG!, `${statSync(file).size}\n`)
await Bun.sleep(50)
