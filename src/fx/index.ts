export { ExchangeRate, RateError, rate } from "./rate.js";

export {
  type Quote,
  type QuoteInput,
  type RateLookup,
  type RateTableOptions,
  NoRateError,
  RateTable,
} from "./table.js";

export {
  type AverageMethod,
  type AverageOptions,
  type AverageRate,
  averageRate,
  dailyAverage,
  meanOfRates,
  quotedAverage,
} from "./average.js";

export {
  type QuoteDocument,
  type RateCsvOptions,
  type RateDocument,
  RateDocumentError,
  ratesFromCsv,
  ratesFromDocument,
  ratesFromJson,
  ratesFromText,
  ratesToDocument,
  ratesToJson,
} from "./document.js";

export {
  type Exposure,
  type ExposureOptions,
  exposureFor,
  exposureForReference,
  exposures,
  renderExposures,
} from "./exposure.js";

export {
  type Revaluation,
  type RevaluationLine,
  type RevaluationOptions,
  RevaluationError,
  applyRevaluation,
  renderRevaluation,
  revalue,
} from "./revaluation.js";

export {
  type Settlement,
  type SettlementOptions,
  SettlementError,
  applySettlement,
  settleForeignItem,
} from "./settlement.js";

export {
  type RateBasis,
  type TranslatedRow,
  type Translation,
  type TranslationOptions,
  TranslationError,
  renderTranslation,
  translate,
} from "./translate.js";
