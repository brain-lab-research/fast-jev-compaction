import { describe, expect, it } from 'vitest';
import { isWritingCall } from '../src/protect.js';

const bash = (command: string) => isWritingCall('Bash', { command });

describe('isWritingCall', () => {
  it('protects the editing tools and leaves reading tools alone', () => {
    expect(isWritingCall('Edit', {})).toBe(true);
    expect(isWritingCall('Write', {})).toBe(true);
    expect(isWritingCall('Read', {})).toBe(false);
    expect(isWritingCall('Grep', {})).toBe(false);
  });

  it('protects MCP writes and not MCP reads', () => {
    expect(isWritingCall('mcp__lab-knowledge__propose', {})).toBe(true);
    expect(isWritingCall('mcp__mempalace__mempalace_add_drawer', {})).toBe(true);
    expect(isWritingCall('mcp__zotero__zotero_update_item', {})).toBe(true);
    expect(isWritingCall('mcp__lab-knowledge__search_lab', {})).toBe(false);
    expect(isWritingCall('mcp__mempalace__mempalace_search', {})).toBe(false);
  });

  it('judges Bash by what the command does', () => {
    expect(bash('ls -la /tmp')).toBe(false);
    expect(bash('grep -rn foo src')).toBe(false);
    expect(bash('git commit -m fix')).toBe(true);
    expect(bash('sed -i "" s/a/b/ f')).toBe(true);
    expect(bash('launchctl unload ~/Library/LaunchAgents/x.plist')).toBe(true);
  });

  it('does not read noise redirects as writing', () => {
    expect(bash('systemctl status nginx 2>/dev/null')).toBe(false);
    expect(bash('ls /nope 2>&1 | tail -3')).toBe(false);
    expect(bash('systemctl restart nginx')).toBe(true);
  });

  it('ignores verbs inside a heredoc body', () => {
    // 767 false positives on one session came from the word `scp` in a script.
    expect(bash("python3 - <<'PY'\nimport os  # scp rm mv\nprint(1)\nPY")).toBe(false);
    expect(bash("cat > /etc/hosts <<'EOF'\nnothing\nEOF")).toBe(true);
  });

  it('treats a scratch target as not durable, through a variable', () => {
    expect(bash('S=/private/tmp/x/scratchpad\nfind . -name "*.md" > "$S/out.txt"')).toBe(false);
    expect(bash('echo hi > /tmp/out.txt')).toBe(false);
    expect(bash('mkdir -p "$TMPDIR/work"')).toBe(false);
    expect(bash('V=/Users/a/vault\ncat x > "$V/note.md"')).toBe(true);
    expect(bash('echo hi > out.txt')).toBe(true);
  });
});
