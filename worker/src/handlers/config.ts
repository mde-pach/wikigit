import { gh } from "../github";
import { HttpError } from "../http";
import { requireMaintainer } from "../identity";
import { commitPayload, getCurrentFile } from "../repo";
import { parseConfigFile, sanitizeConfig, type WikigitConfig } from "../siteconfig";
import { maintainerKeys } from "../trust";
import type { Env } from "../types";

export const CONFIG_PATH = "wikigit.json";

// The wiki's owner-editable config (title / languages / theme), read live from
// the repo. Tenant-aware; the reader merges it over its baked defaults.
export async function getConfig(env: Env): Promise<{ config: WikigitConfig }> {
  const file = await getCurrentFile(
    env,
    `${env.REPO_OWNER}/${env.REPO_NAME}`,
    CONFIG_PATH,
  );
  return { config: parseConfigFile(file?.raw) };
}

// Commit a new config from the settings form. Maintainer-only. The body is
// whitelisted (sanitizeConfig) so only known, well-typed fields are persisted —
// the file can't smuggle arbitrary keys the reader would trust.
export async function putConfig(
  env: Env,
  request: Request,
  body: unknown,
): Promise<{ ok: true; config: WikigitConfig }> {
  const writer = await requireMaintainer(env, request, "Editing settings");
  const config = sanitizeConfig(body);
  // On a hosted wiki the repo is org-owned, so the config list may be the owner's
  // only grant — dropping themselves would lock them out with no one to undo it.
  if (!(await maintainerKeys(env, config.maintainers ?? [])).includes(writer.key))
    throw new HttpError(
      400,
      "You can't remove yourself from the maintainers — you'd lose access to these settings.",
    );
  const repo = `${env.REPO_OWNER}/${env.REPO_NAME}`;
  const current = await getCurrentFile(env, repo, CONFIG_PATH);
  await gh(env, `/repos/${repo}/contents/${CONFIG_PATH}`, {
    method: "PUT",
    body: commitPayload(env, {
      message: "config: update wiki settings",
      content: `${JSON.stringify(config, null, 2)}\n`,
      branch: env.BRANCH,
      sha: current?.sha,
      author: { name: writer.name, email: writer.email },
    }),
  });
  // The settings form can change the maintainer list → drop its cached set.
  await env.RATE_LIMIT?.delete("maintainers:set");
  return { ok: true, config };
}
