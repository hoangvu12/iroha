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
