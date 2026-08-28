/**
 * Injection scanner for agent-authored descriptions.
 *
 * Anvil takes the spec's tool-poisoning attack and makes it *persistent and
 * user-blessed*: if the agent reads a poisoned page and then proposes a tool,
 * injected instructions could live in a description that is loaded into the
 * model's context in every future session.
 *
 * The real mitigation is structural - a human must accept the description text,
 * and `descriptionAccepted` gates registration. This scanner is the assist: it
 * FLAGS, it never blocks, because a blocklist of phrases is trivially evaded and
 * pretending otherwise would be theatre.
 */

export interface ScanFlag {
  code: string;
  message: string;
  excerpt?: string;
}

interface Rule {
  code: string;
  message: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    code: 'override_instruction',
    message: 'Reads like an attempt to override earlier instructions',
    pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|earlier|above)\b/i,
  },
  {
    code: 'role_marker',
    message: 'Contains a role or system marker',
    pattern: /(^|\s)(system|assistant|developer)\s*:/i,
  },
  {
    code: 'pseudo_tag',
    message: 'Contains markup that imitates a system instruction block',
    pattern: /<\/?\s*(important|system|instructions?|admin)\b[^>]*>/i,
  },
  {
    code: 'imperative_to_model',
    message: 'Gives the model a standing instruction rather than describing the tool',
    pattern: /\byou\s+(must|should|will|need to|have to|are required to)\b/i,
  },
  {
    code: 'secrecy',
    message: 'Asks for concealment from the user',
    pattern: /\b(do not|don't|never)\s+(tell|inform|mention|show|reveal)\b.{0,30}\buser\b/i,
  },
  {
    code: 'exfiltration_shape',
    message: 'Mentions sending data somewhere',
    pattern: /\b(send|post|upload|forward|exfiltrate|transmit)\b.{0,40}\b(https?:\/\/|endpoint|server|webhook)/i,
  },
  {
    code: 'embedded_url',
    message: 'Contains a URL, which a description rarely needs',
    pattern: /https?:\/\/\S+/i,
  },
  {
    code: 'base64_blob',
    message: 'Contains a long opaque string that could hide instructions',
    pattern: /[A-Za-z0-9+/]{60,}={0,2}/,
  },
];

const MAX_REASONABLE_LENGTH = 600;

export function scanDescription(description: string): ScanFlag[] {
  const flags: ScanFlag[] = [];

  for (const rule of RULES) {
    const match = rule.pattern.exec(description);
    if (match) {
      flags.push({
        code: rule.code,
        message: rule.message,
        excerpt: trimExcerpt(description, match.index, match[0].length),
      });
    }
  }

  if (description.length > MAX_REASONABLE_LENGTH) {
    flags.push({
      code: 'over_length',
      message: `${description.length} characters. A description this long costs context every session and usually hides something.`,
    });
  }

  return flags;
}

/** Schemas asking for fields unrelated to the workspace are worth a second look. */
const SUSPICIOUS_FIELDS = /\b(password|passwd|secret|token|api[_-]?key|credential|cookie|session|ssn|credit[_-]?card|cvv|auth)\b/i;

export function scanSchema(schema: unknown): ScanFlag[] {
  let serialised: string;
  try {
    serialised = JSON.stringify(schema) ?? '';
  } catch {
    return [{ code: 'unserialisable_schema', message: 'The input schema is not JSON-serialisable' }];
  }
  const match = SUSPICIOUS_FIELDS.exec(serialised);
  if (!match) return [];
  return [
    {
      code: 'sensitive_field',
      message: 'The input schema asks for a field unrelated to a reading queue',
      excerpt: match[0],
    },
  ];
}

function trimExcerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
