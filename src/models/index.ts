/**
 * The explainable cached model catalog of Provider Connections: discovery,
 * merging, provenance, and the scoped list an application may enumerate.
 */
export {
  ModelCatalogService,
  templateAvailabilityFromRegistry,
  templateDiscoveryFromRegistry,
  templateDiscoveryBasePathFromRegistry,
  templateKnowledgeFromRegistry,
  type CatalogEntryView,
  type CatalogSyncView,
  type CatalogView,
  type FieldProblem,
  type ListableModel,
  type ModelCatalogFailure,
  type ModelCatalogResult,
  type ModelCatalogServiceOptions,
} from './catalog-service.ts'
export {
  createModelsDevMetadataFallback,
  lookupModelsDevMetadata,
  parseModelsDevCatalog,
  type ModelMetadataFallback,
  type ModelsDevMetadataFallbackOptions,
} from './models-dev-metadata.ts'
export {
  mergeModelMetadata,
  readInputModalities,
  readModelChatCapability,
  readOutputModalities,
} from './metadata-normalization.ts'
