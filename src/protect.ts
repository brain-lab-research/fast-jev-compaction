/**
 * Calls that must survive compaction regardless of what the classifier says.
 *
 * Measured on a 605-call compaction: Jev scored every single call below the 0.5
 * keep threshold (keepCall 0.13-0.31, keepResult 0.05-0.17), so the transcript
 * lost every record of a file being written or a service being restarted. The
 * upstream `pinned` flag only covers position (first message, last few), not
 * what a call did. Policy beats judgement here: the classifier cannot know that
 * a dropped `rm -rf` is unrecoverable while a dropped `ls` is not.
 *
 * The cost of being sloppy is symmetric: a policy that fires on two calls in
 * three protects everything and compacts nothing. Three measurements on the
 * same 5467-call session took it from 63% to 29% to 6%.
 */

/** Tools whose whole purpose is to change something. */
const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Artifact']);

/** MCP tools change state when their verb says so; the server name varies. */
const WRITING_MCP_VERB =
  /^mcp__.+__(?:.*_)?(?:add|create|update|upsert|delete|remove|set|write|propose|record|submit|approve|reject|revoke|grant|invite|move|save|attach|publish|assign)(?:_|$)/i;

/**
 * Heredoc bodies are data, not commands. A `cat > script.py <<'PY' … PY` call
 * carries a whole program, and matching verbs inside it produced 767 false
 * positives from the word `scp` alone.
 */
function stripHeredocs(command: string): string {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    '<<HEREDOC',
  );
}

/** `2>/dev/null` and `2>&1` are noise suppression, not writing. */
function stripNoiseRedirects(command: string): string {
  return command
    .replace(/\d?>\s*&\s*\d/g, '')
    .replace(/\d?>>?\s*\/dev\/(?:null|stderr|stdout)/g, '');
}

/** Scratch paths: writing there changes nothing that outlives the session. */
const SCRATCH_PATH =
  /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)\/|^(?:\.\/)?(?:tmp|\.cache)\//;

/** `S=/private/tmp/…/scratchpad` then `> "$S/out.txt"`: resolve one level. */
function assignments(command: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of command.matchAll(
    /(?:^|\n|\s|;|&&)([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g,
  )) {
    map.set(m[1]!, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return map;
}

function expand(path: string, vars: Map<string, string>): string {
  const bare = path.replace(/^["']|["']$/g, '');
  return bare.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => {
    const value = vars.get(name);
    if (value !== undefined) return value;
    if (name === 'TMPDIR' || name === 'SCRATCH') return '/tmp';
    return whole;
  });
}

function isScratch(path: string, vars: Map<string, string>): boolean {
  return SCRATCH_PATH.test(expand(path, vars));
}

/** Verbs that change something durable no matter which path they are given. */
const ALWAYS_WRITING = new RegExp(
  `(?:^|\\n|[;(]|&&|\\|\\||\\|)\\s*(?:sudo\\s+)?(?:${[
    String.raw`sed\s+-i\b`, String.raw`perl\s+-i\b`,
    String.raw`git\s+(?:commit|push|merge|rebase|reset|checkout|clean|tag|apply|am|revert)\b`,
    String.raw`(?:npm|pnpm|yarn|pip|pip3|uv|conda|apt|apt-get|brew)\s+(?:install|remove|uninstall|add|purge)\b`,
    String.raw`systemctl\s+(?:--user\s+)?(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b`,
    String.raw`launchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|remove)\b`,
    String.raw`(?:kill|pkill|killall)\b`, String.raw`scp\b`, String.raw`rsync\b`,
    String.raw`crontab\b`, String.raw`chown\b`,
    String.raw`hermes\s+(?:cron|kanban)\s+(?:create|edit|delete|pause|resume|run|comment|claim|assign|take)\b`,
    String.raw`lab\s+(?:pr|take)\b`,
  ].join('|')})`,
  'i',
);

/** Verbs that matter only when their target outlives the session. */
const PATH_VERB = new RegExp(
  String.raw`(?:^|\n|[;(]|&&|\|\||\|)\s*(?:sudo\s+)?(rm|mv|cp|dd|tee|ln|truncate|mkdir|chmod)\b([^\n;|&]*)`,
  'gi',
);

/** Redirects, minus the noise ones already stripped. */
const REDIRECT = /(?:^|\s)\d?>>?\s*(\S+)/g;

/** Does any path this command writes to outlive the session? */
function touchesDurablePath(command: string, vars: Map<string, string>): boolean {
  for (const m of command.matchAll(REDIRECT)) {
    if (!isScratch(m[1] ?? '', vars)) return true;
  }
  for (const m of command.matchAll(PATH_VERB)) {
    const args = (m[2] ?? '')
      .split(/\s+/)
      .filter((a) => a && !a.startsWith('-'));
    if (args.length === 0) return true;          // unreadable: assume it matters
    if (args.some((a) => !isScratch(a, vars))) return true;
  }
  return false;
}

/** Did this call change something outside the conversation? */
export function isWritingCall(
  tool: string,
  input: Record<string, unknown>,
): boolean {
  if (WRITING_TOOLS.has(tool)) return true;
  if (WRITING_MCP_VERB.test(tool)) return true;
  if (tool !== 'Bash') return false;
  const raw = typeof input.command === 'string' ? input.command : '';
  const command = stripNoiseRedirects(stripHeredocs(raw));
  if (ALWAYS_WRITING.test(command)) return true;
  return touchesDurablePath(command, assignments(raw));
}
