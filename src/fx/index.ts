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
