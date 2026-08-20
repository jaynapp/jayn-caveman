export type Provenance = 'assumed' | 'benchmarked';

export interface ToolEffect {
  id: string;
  label: string;

  proseRatio: number;
  source: Provenance;

  n?: number;
}

export interface SavingsEstimate {
  id: string;
  label: string;
  source: Provenance;

  actualUSD: number;

  savedUSD: number;

  pricedTokens: number;

  unpricedTokens: number;

  caveat: string;
}
