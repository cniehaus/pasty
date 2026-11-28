// Creates a release: bumps the version everywhere, commits, tags and pushes.
// The Release workflow then builds the installers and attaches them.
//
//   npm run release 0.1.5
//   npm run release 0.1.5 -- --notes notes.md   # own "what's new" text
//   npm run release 0.1.5 -- --dry-run          # show what would happen
//
// Release text: the notes file (or the commit subjects since the last tag),
// followed by the installation guide in .github/release-footer.md.
// Needs git and the GitHub CLI (gh), logged in.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--notes"));
const dryRun = args.includes("--dry-run");
const notesIndex = args.indexOf("--notes");
const notesFile = notesIndex >= 0 ? args[notesIndex + 1] : null;
// Extra lines for the release commit message (e.g. a Co-authored-by trailer).
const trailer = process.env.PASTA_COMMIT_TRAILER ?? "";

const tag = `v${version}`;

function run(cmd, cmdArgs, { capture = false } = {}) {
  if (dryRun && !capture) {
    console.log(`  (dry run) ${cmd} ${cmdArgs.join(" ")}`);
    return "";
  }
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" }) ?? "";
}

const git = (...a) => run("git", a, { capture: true }).trim();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------- checks ---

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail("Version fehlt oder ist ungültig. Beispiel: npm run release 0.1.5");
}
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("Releases nur vom Branch main.");
if (git("status", "--porcelain")) fail("Es gibt nicht committete Änderungen. Erst committen.");
if (git("tag", "-l", tag)) fail(`Tag ${tag} gibt es schon.`);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current = pkg.version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, current)) fail(`${version} ist nicht neuer als die aktuelle Version ${current}.`);

const previousTag = (() => {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    return null;
  }
})();

console.log(`Release ${current} → ${version}${dryRun ? " (dry run)" : ""}`);

// ------------------------------------------------------ bump versions ---

function edit(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) fail(`Version in ${path} nicht gefunden.`);
  if (!dryRun) writeFileSync(path, after);
  console.log(`  ${path}`);
}

const setJsonVersion = (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("package.json", setJsonVersion);
edit("src-tauri/tauri.conf.json", setJsonVersion);
// First `version =` in Cargo.toml is the [package] version.
edit("src-tauri/Cargo.toml", (t) => t.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (t) =>
  t.replace(/(name = "pasta"\nversion = ")[^"]+(")/, `$1${version}$2`),
);
run("npm", ["install", "--package-lock-only", "--silent"]);

// ------------------------------------------------- commit, tag, push ---

const message = `Release ${version}${trailer ? `\n\n${trailer}` : ""}`;
run("git", ["commit", "-am", message]);
run("git", ["tag", "-a", tag, "-m", `Pasta ${version}`]);
run("git", ["push"]);
run("git", ["push", "origin", tag]);

// ------------------------------------------------------ release text ---

function changes() {
  if (notesFile) return readFileSync(notesFile, "utf8").trim();
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const subjects = git("log", "--format=%s", range)
    .split("\n")
    .filter((s) => s && !/^Release \d/.test(s));
  return `## Neu in ${version}\n\n${subjects.map((s) => `- ${s}`).join("\n")}`;
}

const footer = readFileSync(".github/release-footer.md", "utf8").trim();
const notes = `${changes()}\n\n${footer}\n`;
const notesPath = join(mkdtempSync(join(tmpdir(), "pasta-release-")), "notes.md");
writeFileSync(notesPath, notes);

if (dryRun) {
  console.log("\n--- Release-Text ---\n" + notes);
  process.exit(0);
}

// The workflow may create the release first; then just update its text.
const title = `Pasta ${version} (Vorabversion)`;
try {
  execFileSync("gh", ["release", "create", tag, "--prerelease", "--verify-tag", "--title", title, "--notes-file", notesPath], {
    stdio: "pipe",
  });
} catch {
  run("gh", ["release", "edit", tag, "--title", title, "--notes-file", notesPath]);
}

const repo = git("remote", "get-url", "origin").replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
console.log(`\n✓ ${tag} gepusht. Die Installer werden jetzt gebaut (ca. 5–10 Minuten):`);
console.log(`  https://github.com/${repo}/releases/tag/${tag}`);
