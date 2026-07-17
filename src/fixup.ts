// Shell snippets shared between the devcontainer lifecycle commands
// (src/devcontainer.ts, run by `devcontainer up`) and the attach-time
// self-heal (src/worktree.ts ensureContainerFixups). Keeping them in one
// place prevents the two copies drifting apart — the tmux guard below was
// previously duplicated and one copy had an operator-precedence bug that
// ran apt-get on every container start.

// Chown shared volumes to vscode, but only when the mountpoint isn't
// already vscode-owned (Docker creates fresh named volumes root-owned).
// Guarded per-path so warm volumes with thousands of files skip the
// recursive chown entirely. Must run BEFORE postCreate (i.e. from
// onCreateCommand), otherwise the project's bundle install hits a
// root-owned /usr/local/bundle and the gem cache never warms.
//
// ~/.local is in the list for images that lack it entirely: mounting
// cwt-claude-share at ~/.local/share/claude makes dockerd create the
// missing parent dirs root-owned, which would break both the claude
// installer and the symlink restore. On images that ship a vscode-owned
// ~/.local (e.g. the rails devcontainer, where it holds mise's ruby) the
// ownership guard skips it, so the recursive chown never touches mise.
export const VOLUME_CHOWN_FIXUP = [
  "for d in /home/vscode/.claude /home/vscode/.config/gh /home/vscode/.local /home/vscode/.local/share/claude /usr/local/bundle /usr/local/cargo/registry",
  'do if [ -e "$d" ] && [ "$(stat -c %U "$d" 2>/dev/null)" != "vscode" ]',
  'then sudo chown -R vscode:vscode "$d" 2>/dev/null || true',
  "fi",
  "done",
].join("; ");

// Recreate ~/.local/bin/claude from the shared cwt-claude-share volume
// (mounted at ~/.local/share/claude). The installer symlinks the binary as
// ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>; the versions
// dir survives on the volume but ~/.local/bin is container-local, so a
// fresh container just needs the symlink back — no 250MB re-download.
export const CLAUDE_RESTORE_FIXUP = [
  "if [ ! -x /home/vscode/.local/bin/claude ] && [ -d /home/vscode/.local/share/claude/versions ]",
  "then v=$(ls -1 /home/vscode/.local/share/claude/versions 2>/dev/null | sort -V | tail -n1)",
  'if [ -n "$v" ] && [ -x "/home/vscode/.local/share/claude/versions/$v" ]',
  'then mkdir -p /home/vscode/.local/bin && ln -sf "/home/vscode/.local/share/claude/versions/$v" /home/vscode/.local/bin/claude',
  "fi",
  "fi",
].join("; ");

// Restore from the volume first; download only as a last resort (fresh
// volume, or the volume was wiped).
export const CLAUDE_INSTALL_FIXUP =
  CLAUDE_RESTORE_FIXUP +
  "; test -x /home/vscode/.local/bin/claude || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || true";

// tmux's default config eats paste. Drop a ~/.tmux.conf that turns on
// clipboard passthrough + bracketed paste so OAuth codes etc. can be
// pasted into cwt attach without tmux intercepting.
export const TMUX_CONF_FIXUP =
  "test -f /home/vscode/.tmux.conf || printf '%s\\n' 'set -g mouse on' 'set -g set-clipboard on' 'set -g default-terminal \"tmux-256color\"' 'set -ga terminal-overrides \",*256col*:Tc\"' 'set -s escape-time 0' 'bind-key -T copy-mode-vi v send-keys -X begin-selection' 'bind-key -T copy-mode-vi y send-keys -X copy-selection' > /home/vscode/.tmux.conf";

// Install tmux on demand. Only cwt attach needs tmux, so this runs from
// the attach-time self-heal, NOT from the create-time lifecycle — keeping
// apt off cwt new's critical path. Parenthesized so apt only runs when
// tmux is actually missing.
export const TMUX_INSTALL_FIXUP =
  "command -v tmux >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends tmux >/dev/null 2>&1) || true";

// claude stores auth in TWO places: ~/.claude/.credentials.json (in the
// shared volume) AND ~/.claude.json (top-level file, NOT in the volume by
// default). Symlink the latter into the volume so it persists across
// containers too. If the volume already has a .claude.json (from a prior
// container), the symlink picks it up; if not, replace the local file with
// a symlink so the next claude write lands in the volume.
export const CLAUDE_JSON_SYMLINK_FIXUP =
  "if [ ! -L /home/vscode/.claude.json ]; then if [ -f /home/vscode/.claude/.claude.json ]; then rm -f /home/vscode/.claude.json; ln -sf /home/vscode/.claude/.claude.json /home/vscode/.claude.json; elif [ -f /home/vscode/.claude.json ]; then mv /home/vscode/.claude.json /home/vscode/.claude/.claude.json && ln -sf /home/vscode/.claude/.claude.json /home/vscode/.claude.json; else ln -sf /home/vscode/.claude/.claude.json /home/vscode/.claude.json; fi; fi";
