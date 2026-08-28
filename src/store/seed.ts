import type { Item, ItemStatus } from './types';

/**
 * Seed data for a cold-open judge.
 *
 * Deliberately messy, because the whole product is about capturing the
 * idiosyncratic procedure that cleans it up:
 *  - tracking parameters on anything that arrived by newsletter
 *  - the same source spelled three ways ("arXiv" / "arxiv.org" / "Arxiv")
 *  - the same tag cased three ways ("ml" / "ML" / "machine-learning")
 *  - near-duplicates: a paper, a blog summary of it, and a thread about it
 *  - stale unread items that should have been archived months ago
 *  - a couple of items whose titles are the raw <title> tag, not a real title
 */

interface SeedItem {
  url: string;
  title: string;
  source: string;
  tags: string[];
  status: ItemStatus;
  notes: string;
  daysAgo: number;
}

const SEED: readonly SeedItem[] = [
  // --- databases ------------------------------------------------------------
  {
    url: 'https://www.vldb.org/pvldb/vol16/p2047-zhang.pdf',
    title: 'Are We Ready For Learned Cardinality Estimation?',
    source: 'VLDB',
    tags: ['databases', 'query-optimization', 'ml'],
    status: 'unread',
    notes: 'Cited in the planner thread. Read before touching the estimator.',
    daysAgo: 12,
  },
  {
    url: 'https://www.cs.cmu.edu/~pavlo/blog/2023/04/the-part-of-postgresql-we-hate-the-most.html',
    title: 'The Part of PostgreSQL We Hate the Most',
    source: 'Andy Pavlo',
    tags: ['databases', 'postgres', 'mvcc'],
    status: 'done',
    notes: 'The autovacuum section is the one to re-read.',
    daysAgo: 96,
  },
  {
    url: 'https://notes.eatonphil.com/2024-05-16-mvcc.html',
    title: 'Implementing MVCC and major SQL transaction isolation levels',
    source: 'Phil Eaton',
    tags: ['databases', 'mvcc', 'transactions'],
    status: 'reading',
    notes: '',
    daysAgo: 21,
  },
  {
    url: 'https://transactional.blog/blog/2025-modern-btree-techniques?utm_source=bytebytego&utm_medium=newsletter&utm_campaign=weekly',
    title: 'transactional.blog',
    source: 'newsletter',
    tags: ['databases', 'btree', 'storage'],
    status: 'unread',
    notes: '',
    daysAgo: 8,
  },
  {
    url: 'https://www.sqlite.org/whybytecode.html',
    title: 'Why SQLite Uses Bytecode',
    source: 'sqlite.org',
    tags: ['databases', 'sqlite', 'interpreters'],
    status: 'unread',
    notes: '',
    daysAgo: 47,
  },
  {
    url: 'https://jepsen.io/analyses/datomic-pro-1.0.7075',
    title: 'Jepsen: Datomic Pro 1.0.7075',
    source: 'Jepsen',
    tags: ['databases', 'consistency', 'testing'],
    status: 'unread',
    notes: 'Skim the summary, keep the methodology section.',
    daysAgo: 63,
  },
  {
    url: 'https://muratbuffalo.blogspot.com/2024/03/hekaton-sql-servers-memory-optimized.html',
    title: 'Hekaton: SQL Server memory-optimized OLTP engine',
    source: 'Murat Demirbas',
    tags: ['databases', 'oltp', 'papers'],
    status: 'archived',
    notes: '',
    daysAgo: 141,
  },

  // --- the near-duplicate cluster (one paper, three artefacts) --------------
  {
    url: 'https://arxiv.org/abs/2205.14135',
    title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
    source: 'arXiv',
    tags: ['ml', 'attention', 'systems'],
    status: 'unread',
    notes: '',
    daysAgo: 34,
  },
  {
    url: 'https://arxiv.org/abs/2205.14135v2',
    title: 'FlashAttention: Fast and Memory Efficient Exact Attention with IO Awareness (v2)',
    source: 'arxiv.org',
    tags: ['ML', 'attention'],
    status: 'unread',
    notes: 'think this is the same thing I already saved',
    daysAgo: 33,
  },
  {
    url: 'https://gordicaleksa.medium.com/eli5-flash-attention-e6cd6c0f0ee1',
    title: 'ELI5: FlashAttention',
    source: 'Medium',
    tags: ['machine-learning', 'attention', 'explainer'],
    status: 'unread',
    notes: '',
    daysAgo: 30,
  },

  // --- machine learning -----------------------------------------------------
  {
    url: 'https://arxiv.org/abs/2001.08361',
    title: 'Scaling Laws for Neural Language Models',
    source: 'Arxiv',
    tags: ['ml', 'scaling', 'papers'],
    status: 'done',
    notes: 'The one everyone quotes and nobody re-reads.',
    daysAgo: 210,
  },
  {
    url: 'https://arxiv.org/abs/2203.15556',
    title: 'Training Compute-Optimal Large Language Models',
    source: 'arXiv',
    tags: ['ml', 'scaling'],
    status: 'unread',
    notes: '',
    daysAgo: 88,
  },
  {
    url: 'https://lilianweng.github.io/posts/2023-06-23-agent/',
    title: "LLM Powered Autonomous Agents",
    source: 'Lilian Weng',
    tags: ['agents', 'ml'],
    status: 'reading',
    notes: 'Section on memory is the useful part for Anvil.',
    daysAgo: 16,
  },
  {
    url: 'https://www.anthropic.com/engineering/building-effective-agents?utm_source=tldr&utm_medium=newsletter',
    title: 'Building effective agents',
    source: 'newsletter',
    tags: ['agents', 'ML'],
    status: 'unread',
    notes: '',
    daysAgo: 5,
  },
  {
    url: 'https://karpathy.github.io/2019/04/25/recipe/',
    title: 'A Recipe for Training Neural Networks',
    source: 'Karpathy',
    tags: ['ml', 'practice'],
    status: 'done',
    notes: '',
    daysAgo: 340,
  },
  {
    url: 'https://arxiv.org/abs/2402.01030',
    title: 'Executable Code Actions Elicit Better LLM Agents',
    source: 'arxiv.org',
    tags: ['agents', 'machine-learning', 'papers'],
    status: 'unread',
    notes: 'Relevant to the propose_tool loop.',
    daysAgo: 19,
  },

  // --- systems / web --------------------------------------------------------
  {
    url: 'https://github.com/webmachinelearning/webmcp',
    title: 'webmachinelearning/webmcp: Web Model Context Protocol',
    source: 'GitHub',
    tags: ['webmcp', 'specs'],
    status: 'reading',
    notes: 'Read the security considerations section twice.',
    daysAgo: 3,
  },
  {
    url: 'https://developer.chrome.com/docs/ai/webmcp',
    title: 'WebMCP  |  Chrome for Developers',
    source: 'Chrome',
    tags: ['webmcp', 'specs'],
    status: 'reading',
    notes: '',
    daysAgo: 3,
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox',
    title: 'iframe: the sandbox attribute - MDN',
    source: 'MDN',
    tags: ['web', 'security'],
    status: 'unread',
    notes: 'Confirm opaque origin semantics before writing the executor.',
    daysAgo: 2,
  },
  {
    url: 'https://web.dev/articles/origin-agent-cluster',
    title: 'Requesting performance isolation with the Origin-Agent-Cluster header',
    source: 'web.dev',
    tags: ['web', 'headers'],
    status: 'done',
    notes: '?0 disables WebMCP entirely. Do not forget this.',
    daysAgo: 1,
  },
  {
    url: 'https://danluu.com/latency-pitfalls/',
    title: 'Some latency measurement pitfalls',
    source: 'Dan Luu',
    tags: ['performance', 'measurement'],
    status: 'unread',
    notes: '',
    daysAgo: 118,
  },
  {
    url: 'https://brooker.co.za/blog/2024/06/04/scale.html',
    title: 'Scalability is Quantifiable',
    source: 'Marc Brooker',
    tags: ['systems', 'scaling'],
    status: 'unread',
    notes: '',
    daysAgo: 74,
  },
  {
    url: 'https://www.usenix.org/system/files/osdi21-zhou.pdf',
    title: 'osdi21-zhou.pdf',
    source: 'USENIX',
    tags: ['systems', 'papers'],
    status: 'unread',
    notes: 'no idea what this one is anymore',
    daysAgo: 156,
  },
  {
    url: 'https://ferd.ca/the-review-is-the-action-item.html',
    title: 'The Review Is The Action Item',
    source: 'Fred Hebert',
    tags: ['incidents', 'practice'],
    status: 'done',
    notes: '',
    daysAgo: 55,
  },

  // --- writing / misc -------------------------------------------------------
  {
    url: 'https://www.bitsaboutmoney.com/archive/the-waste-is-the-point/?utm_source=substack&utm_medium=email',
    title: 'The waste is the point',
    source: 'newsletter',
    tags: ['finance', 'essays'],
    status: 'unread',
    notes: '',
    daysAgo: 9,
  },
  {
    url: 'https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/',
    title: 'Things You Should Never Do, Part I',
    source: 'Joel Spolsky',
    tags: ['essays', 'practice'],
    status: 'archived',
    notes: '',
    daysAgo: 400,
  },
  {
    url: 'https://apenwarr.ca/log/20211129',
    title: 'Business books are all the same',
    source: 'apenwarr',
    tags: ['essays'],
    status: 'unread',
    notes: '',
    daysAgo: 132,
  },
  {
    url: 'https://newsletter.pragmaticengineer.com/p/the-pulse-96?utm_source=post-email-title&utm_campaign=email-post-title',
    title: 'The Pulse #96',
    source: 'newsletter',
    tags: ['industry'],
    status: 'unread',
    notes: '',
    daysAgo: 6,
  },
  {
    url: 'https://overreacted.io/algebraic-effects-for-the-rest-of-us/',
    title: 'Algebraic Effects for the Rest of Us',
    source: 'Dan Abramov',
    tags: ['programming', 'essays'],
    status: 'unread',
    notes: '',
    daysAgo: 91,
  },
  {
    url: 'https://simonwillison.net/2025/Jan/10/ai-predictions/',
    title: 'Things we learned about LLMs',
    source: 'Simon Willison',
    tags: ['ml', 'industry'],
    status: 'reading',
    notes: '',
    daysAgo: 14,
  },
];

const DAY_MS = 86_400_000;

export function buildSeedItems(now: number = Date.now()): Item[] {
  return SEED.map((seed, index) => {
    const addedAt = now - seed.daysAgo * DAY_MS;
    return {
      // Stable ids so a reseed is idempotent and the demo script can name one.
      id: `seed_${String(index + 1).padStart(2, '0')}`,
      url: seed.url,
      title: seed.title,
      source: seed.source,
      tags: [...seed.tags],
      status: seed.status,
      notes: seed.notes,
      addedAt,
      updatedAt: addedAt,
    } satisfies Item;
  });
}

export const SEED_COUNT = SEED.length;
