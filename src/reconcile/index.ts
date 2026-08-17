export {
  type BookLine,
  type BankViewOptions,
  bankView,
  bookLineTotal,
  isMoneyInBook,
  isMoneyOutBook,
} from "./bankView.js";

export {
  type SimilarityBreakdown,
  tokenise,
  levenshtein,
  levenshteinRatio,
  jaro,
  jaroWinkler,
  isReferenceToken,
  referenceTokens,
  sharedReferences,
  tokenOverlap,
  similarityBreakdown,
  descriptionSimilarity,
} from "./similarity.js";

export {
  type Subset,
  type SubsetSearchOptions,
  type SubsetSearchResult,
  findSubsets,
  findBestSubset,
} from "./subsetSum.js";

export {
  type AssignmentPair,
  type AssignmentResult,
  type AssignmentOptions,
  type WeightedEdge,
  AssignmentShapeError,
  maximumWeightMatching,
  maximumWeightMatchingSparse,
  greedyMatching,
} from "./assignment.js";

export {
  type Gateable,
  type CandidatePair,
  type CandidateIndexStats,
  CandidateIndex,
  candidatePairs,
} from "./candidates.js";

export {
  type RuleName,
  type MatchReason,
  type Confidence,
  type ScoredMatch,
  type ScoringWeights,
  type ScoringOptions,
  type ResolvedScoringOptions,
  DEFAULT_WEIGHTS,
  resolveScoringOptions,
  scorePair,
  scoreGroup,
} from "./scoring.js";

export {
  type MatchKind,
  type Match,
  type ReconciliationOptions,
  type ReconciliationResult,
  type ReconciliationStats,
  reconcile,
  describeMatch,
  significantReasons,
} from "./matcher.js";

export {
  type BridgeInput,
  type ReconciliationBridge,
  reconciliationBridge,
  statementClosingBalance,
  renderReconciliationBridge,
} from "./bridge.js";

export {
  type TruthLink,
  type AccuracyReport,
  type AccuracyFailure,
  measureAccuracy,
  renderAccuracy,
} from "./accuracy.js";

export {
  type Decision,
  type MemoryEntry,
  type MemoryKind,
  type MemoryVerdict,
  type MemoryDocument,
  MatchMemory,
  MemoryDocumentError,
  counterpartyKey,
  renderMemory,
} from "./memory.js";

export {
  type DecisionRecord,
  type DecisionContext,
  type DecisionPayload,
  DecisionDocumentError,
  decisionPayloads,
  decisionRecord,
  toDecision,
  parseDecisions,
  decisionsFromDocument,
  serialiseDecisions,
  decisionsFor,
} from "./decisions.js";
