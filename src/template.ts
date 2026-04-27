import { Eta } from "eta";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { ensureDir } from "./util.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(here, "..", "templates");

const eta = new Eta({
  views: TEMPLATE_ROOT,
  cache: false,
  autoEscape: false,
});

export async function renderTemplate(
  templateName: string,
  locals: Record<string, unknown>,
): Promise<string> {
  const result = await eta.renderAsync(templateName, locals);
  if (typeof result !== "string") {
    throw new Error(`Template "${templateName}" did not render to a string`);
  }
  return result;
}

export async function writeTemplate(
  templateName: string,
  outputPath: string,
  locals: Record<string, unknown>,
): Promise<void> {
  const rendered = await renderTemplate(templateName, locals);
  await ensureDir(dirname(outputPath));
  await writeFile(outputPath, rendered, "utf8");
}

export function templatePath(name: string): string {
  return join(TEMPLATE_ROOT, name);
}
