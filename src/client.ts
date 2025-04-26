import type { App } from "./index"
import { hc } from "hono/client"
import { STORE_URL } from "./constants"

// —————————————————————————————————————————————————————————————————————————————
// Client

/** RPC client for RC Store. */
const client = hc<App>(STORE_URL)
export default client
