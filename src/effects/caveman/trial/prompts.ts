export const TIERS = ['oneshot', 'short', 'long'] as const;
export type Tier = (typeof TIERS)[number];

export const LANGS = ['en', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

export interface TrialPrompt {
  id: string;

  tier: Tier;
  text: Record<Lang, string>;
}

const ONESHOT: TrialPrompt[] = [
  {
    id: 'rebase-vs-merge',
    tier: 'oneshot',
    text: {
      en: 'Explain the difference between git rebase and git merge. When should I use each one, and what are the tradeoffs?',
      fr: 'Explique la différence entre git rebase et git merge. Quand utiliser l’un ou l’autre, et quels sont les compromis ?',
    },
  },
  {
    id: 'jwt-expiry',
    tier: 'oneshot',
    text: {
      en: "My Express auth middleware lets expired JWTs through. The expiry check compares Date.now() to the token's exp field. What is wrong and how do I fix it?",
      fr: 'Mon middleware d’authentification Express laisse passer des JWT expirés. Le contrôle d’expiration compare Date.now() au champ exp du token. Où est l’erreur et comment la corriger ?',
    },
  },
  {
    id: 'pool-config',
    tier: 'oneshot',
    text: {
      en: 'How do I set up a PostgreSQL connection pool in Node.js with sensible timeout and error handling configuration?',
      fr: 'Comment configurer un pool de connexions PostgreSQL en Node.js avec des timeouts et une gestion d’erreurs corrects ?',
    },
  },
];

const SHORT: TrialPrompt[] = [
  {
    id: 'style-floor',
    tier: 'short',
    text: {
      en: 'In this repository, what does styleOf return for a turn shorter than its minimum, and which callers drop that turn as a result?',
      fr: 'Dans ce dépôt, que renvoie styleOf pour un tour plus court que son minimum, et quels appelants suppriment ce tour en conséquence ?',
    },
  },
  {
    id: 'lastofrun-rule',
    tier: 'short',
    text: {
      en: 'Read src/transcript/session.ts and tell me the exact rule that decides whether a turn closes a run, and why it takes the whole turn list.',
      fr: 'Lis src/transcript/session.ts et explique la règle exacte qui détermine si un tour clôt une run, et pourquoi elle prend la liste complète des tours.',
    },
  },
  {
    id: 'ratio-provenance',
    tier: 'short',
    text: {
      en: 'Where does the 0.35 prose ratio come from in this repository, and which turns is it actually measured on?',
      fr: 'D’où vient le ratio de prose 0.35 dans ce dépôt, et sur quels tours est-il réellement mesuré ?',
    },
  },
];

const LONG: TrialPrompt[] = [
  {
    id: 'add-test-lastofrun',
    tier: 'long',
    text: {
      en: 'Add unit tests for lastOfRunFlags in src/transcript/session.ts covering the single-turn case, a two-run session, and a session whose final turn is mid-run. Run the test suite for that file and fix anything that fails.',
      fr: 'Ajoute des tests unitaires pour lastOfRunFlags dans src/transcript/session.ts couvrant le cas à un seul tour, une session à deux runs, et une session dont le dernier tour est en milieu de run. Lance la suite de tests de ce fichier et corrige ce qui échoue.',
    },
  },
  {
    id: 'trace-pfire',
    tier: 'long',
    text: {
      en: 'Trace how p_fire is fitted in this repository, from raw transcripts through to the number the report prints. Name each file in the chain and what it contributes, then tell me which step is the weakest link.',
      fr: 'Retrace la façon dont p_fire est ajusté dans ce dépôt, des transcripts bruts jusqu’au nombre affiché par le rapport. Nomme chaque fichier de la chaîne et ce qu’il apporte, puis dis-moi quelle étape est le maillon faible.',
    },
  },
  {
    id: 'audit-band-edges',
    tier: 'long',
    text: {
      en: 'Audit the BANDS table in src/effects/caveman/compliance.ts: check that the edges are contiguous, that BAND_WEIGHT matches them, and that every consumer handles the top band. Write a test for whichever property is currently untested.',
      fr: 'Audite la table BANDS dans src/effects/caveman/compliance.ts : vérifie que les bornes sont contiguës, que BAND_WEIGHT leur correspond, et que chaque consommateur gère la dernière bande. Écris un test pour la propriété qui n’en a pas.',
    },
  },
];

export const PROMPTS: readonly TrialPrompt[] = [...ONESHOT, ...SHORT, ...LONG];
