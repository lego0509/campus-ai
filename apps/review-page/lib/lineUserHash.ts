import crypto from "crypto";
import { getEnv } from "./env";

export function lineUserIdToHash(lineUserId: string) {
  const pepper = getEnv("LINE_HASH_PEPPER");
  if (!pepper) throw new Error("LINE_HASH_PEPPER is not set");
  return crypto.createHmac("sha256", pepper).update(lineUserId, "utf8").digest("hex");
}
