import { Note } from '../types/index.ts';

export const INITIAL_SEED_NOTES: Note[] = [
  {
    id: 'note-project-ollama-secondbrain',
    title: 'Project: Local AI Second Brain with Ollama & GPT-OSS:20B',
    category: 'projects',
    tags: ['secondbrain', 'ollama', 'gpt-oss', 'local-ai'],
    isPinned: true,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3, // 3 days ago
    updatedAt: Date.now() - 1000 * 60 * 30, // 30 mins ago
    content: `# Project: Local AI Second Brain Setup

Build a private, minimal, and lightning-fast personal knowledge synthesis system directly on local desktop hardware.

## Core Objectives
- **Zero Cloud Dependence**: Notes remain 100% on local disk; LLM runs on local Ollama daemon.
- **Model**: \`gpt-oss:20b\` (20B parameter dense/MoE local weight, ideal balance of reasoning depth and fast token generation).
- **Frictionless Capture**: Immediate thought capture without friction or cognitive overhead.
- **RAG & Distillation**: Context-aware queries across notes with citations.

## Action Checklist
- [x] Install Ollama desktop application
- [x] Pull \`gpt-oss:20b\` locally via terminal: \`ollama pull gpt-oss:20b\`
- [x] Enable web access origin: \`OLLAMA_ORIGINS="*" ollama serve\`
- [ ] Establish daily 5-minute capture habit before shutdown
- [ ] Connect Obsidian / Markdown notes backup folder

## Technical Reference
Ollama local server runs at \`http://localhost:11434\`.
To verify running models in terminal:
\`\`\`bash
ollama list
ollama run gpt-oss:20b
\`\`\`
`,
  },
  {
    id: 'note-resource-prompt-cheatsheet',
    title: 'Resource: GPT-OSS:20B Prompt Engineering & Distillation Cheatsheet',
    category: 'resources',
    tags: ['prompts', 'gpt-oss', 'ollama', 'distillation'],
    isPinned: true,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 5,
    updatedAt: Date.now() - 1000 * 60 * 60 * 4,
    content: `# Resource: GPT-OSS:20B Prompt Engineering Cheatsheet

Guidelines for extracting highest-density synthesis from the 20B parameter local model.

### 1. Second Brain RAG Grounding
When passing context notes to \`gpt-oss:20b\`, wrap notes in structured markdown blocks. Explicitly forbid external hallucinations:
> *"Synthesize answers using only facts contained in the provided notes. Cite the note title [Note Title] for every major assertion."*

### 2. High-Yield Action Item Extraction
Prompt pattern:
\`\`\`text
Extract all commitments, deadlines, and deliverables.
Format as: - [ ] [Priority] Task description (Owner/Context)
\`\`\`

### 3. Progressive Summarization (CODE Method)
- Layer 1: Raw captured notes
- Layer 2: Bold key sentences
- Layer 3: Highlight breakthrough insights
- Layer 4: Executive mini-summary generated via local Ollama
`,
  },
  {
    id: 'note-area-deep-work-routines',
    title: 'Area: Deep Work & Cognitive Habits',
    category: 'areas',
    tags: ['productivity', 'habits', 'deep-work'],
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    updatedAt: Date.now() - 1000 * 60 * 60 * 12,
    content: `# Area: Deep Work & Cognitive Habits

Ongoing operational standards for maintaining attention capital.

## Morning Focus Block (08:30 - 11:30)
- Zero email, messaging, or social apps during this window.
- Work on the single highest-leverage task identified the prior evening.
- Keep the Second Brain scratchpad open in split view for immediate thought capture without tab switching.

## Evening Knowledge Clearing (17:00 - 17:15)
- Process Inbox notes into PARA buckets:
  - **Projects**: Active efforts with a deadline and specific outcome.
  - **Areas**: Ongoing responsibilities with standards to uphold.
  - **Resources**: Reference topics, guides, snippets, prompts.
  - **Archives**: Inactive items preserved for historical lookup.
`,
  },
  {
    id: 'note-inbox-frictionless-capture',
    title: 'Quick Thought: Cognitive Leverage of Local LLMs vs Cloud',
    category: 'inbox',
    tags: ['insights', 'privacy', 'local-ai'],
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 2,
    updatedAt: Date.now() - 1000 * 60 * 60 * 2,
    content: `# Quick Thought: Cognitive Leverage of Local LLMs vs Cloud

When an AI runs locally on your machine (like GPT-OSS 20B on Ollama):
1. **Psychological Safety**: You write raw, unfiltered thoughts, financials, and draft strategies without worrying about data retention, telemetry, or server logs.
2. **Infinite Iteration**: No token budgets or rate limits. You can run 50 summarizations a minute without incurring API costs.
3. **Offline Resilience**: Works on flights, trains, and during network outages.

Compounding knowledge requires continuous externalization of your mind.
`,
  },
  {
    id: 'note-archive-legacy-stack',
    title: 'Archive: 2024 Cloud Note Stack Migration Notes',
    category: 'archives',
    tags: ['migration', 'history', 'markdown'],
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 30,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 15,
    content: `# Archive: 2024 Cloud Note Stack Migration Notes

Historical record of migrating from proprietary subscription tools to local markdown + Ollama.

## Why We Migrated
- Vendor lock-in and proprietary sync databases
- Laggy search across 5,000+ notes
- Missing local LLM integration without sending corporate notes to 3rd-party servers

## Archive Resolution
All notes exported to universal \`.md\` files with standard YAML frontmatter tags. Fully portable for decades.
`,
  },
];
