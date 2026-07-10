import path from "path"
import { Global } from "../global"

export const ATTACHMENT_DIR = path.join(Global.Path.data, "attachment")
export const ATTACHMENT_GLOB = path.join(ATTACHMENT_DIR, "*")
